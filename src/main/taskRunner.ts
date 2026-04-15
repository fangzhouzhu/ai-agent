/**
 * taskRunner.ts — 独立的后台任务执行引擎
 *
 * 设计原则：
 * - 任务与对话完全隔离，互不影响
 * - 每个任务有唯一 ID，支持并发（多任务同时跑，各自推进度）
 * - 通过 BrowserWindow.webContents.send 实时推送步骤进度到渲染进程
 * - 任务步骤：plan → 逐步工具调用 → 最终 AI 总结 → 可选生成报告
 */

import { BrowserWindow, app } from "electron";
import { join } from "path";
import * as fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { allTools } from "./tools";
import {
  invokeOpenAICompatibleChat,
  type CompatibleMessage,
  OPENAI_COMPATIBLE_TOOLS,
} from "./openaiCompatible";
import { chatWithAgent, getAgentProvider, getAgentModel } from "./agent";
import type { SkillConfig } from "./storage";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStep = {
  id: string;
  type: "plan" | "tool_call" | "tool_result" | "thinking" | "output" | "error";
  label: string; // 简短描述，用于 UI 列表
  content: string; // 详细内容
  timestamp: number;
};

export type Task = {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  steps: TaskStep[];
  result: string; // 最终输出（Markdown）
  outputFiles: string[]; // 生成的文件路径
  createdAt: number;
  updatedAt: number;
};

// ─── 任务持久化 ────────────────────────────────────────────────────────────────

const tasks = new Map<string, Task>();

function getTasksFile(): string {
  const dir = join(app.getPath("userData"), "ai-agent");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return join(dir, "tasks.json");
}

function saveTasks(): void {
  try {
    const data = [...tasks.values()];
    fs.writeFileSync(getTasksFile(), JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // 持久化失败不影响运行
  }
}

function loadTasks(): void {
  try {
    const file = getTasksFile();
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Task[];
    for (const task of data) {
      // 重启后把「执行中/等待中」的任务标记为失败
      if (task.status === "running" || task.status === "pending") {
        task.status = "failed";
        task.steps.push({
          id: uuidv4(),
          type: "error",
          label: "应用重启，任务中断",
          content: "应用重启导致任务中断，如需继续请重新创建任务。",
          timestamp: Date.now(),
        });
        task.updatedAt = Date.now();
      }
      tasks.set(task.id, task);
    }
  } catch {
    // 读取失败忽略
  }
}

// 启动时加载
loadTasks();

function getWebContents(): Electron.WebContents | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0].webContents : null;
}

function pushUpdate(task: Task): void {
  const wc = getWebContents();
  if (wc && !wc.isDestroyed()) {
    wc.send("task:update", toTaskSnapshot(task));
  }
}

function toTaskSnapshot(task: Task): Task {
  return { ...task, steps: [...task.steps] };
}

function addStep(
  task: Task,
  step: Omit<TaskStep, "id" | "timestamp">,
): TaskStep {
  const s: TaskStep = {
    id: uuidv4(),
    timestamp: Date.now(),
    ...step,
  };
  task.steps.push(s);
  task.updatedAt = Date.now();
  pushUpdate(task);
  return s;
}

// ─── 公开 API ──────────────────────────────────────────────────────────────────

export function listTasks(): Task[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "running") return false;
  task.status = "cancelled";
  task.updatedAt = Date.now();
  pushUpdate(task);
  saveTasks();
  return true;
}

export function deleteTask(id: string): boolean {
  const result = tasks.delete(id);
  if (result) saveTasks();
  return result;
}

/**
 * 创建并立即异步执行一个任务，立即返回任务 ID。
 * 执行进度通过 IPC 事件 `task:update` 实时推送。
 */
export function createAndRunTask(prompt: string): string {
  const id = uuidv4();
  const now = Date.now();

  const task: Task = {
    id,
    title: prompt.slice(0, 60) + (prompt.length > 60 ? "…" : ""),
    prompt,
    status: "pending",
    steps: [],
    result: "",
    outputFiles: [],
    createdAt: now,
    updatedAt: now,
  };

  tasks.set(id, task);
  saveTasks();

  // 立即推送初始状态
  pushUpdate(task);

  // 异步执行，不阻塞调用方
  void runTask(task);

  return id;
}

// ─── 核心执行逻辑 ──────────────────────────────────────────────────────────────

function getTaskSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  return `你是一个任务执行助手。用户会给你一个需要完成的端到端任务。
【当前真实日期】${dateStr}。所有涉及时间的操作（如"最近一个月""本周""近期"）均以此日期为准，不得使用训练数据中的假设日期。搜索时请在关键词中明确包含具体年月（如 ${now.getFullYear()}年${now.getMonth() + 1}月）。
你必须通过调用工具来完成这个任务，可以使用以下工具：
- web_search: 联网搜索信息
- fetch_url: 抓取网页内容
- write_file: 将内容写入文件
- read_file: 读取文件内容
- generate_pdf: 生成 PDF 报告
- generate_pptx: 生成 PPT 演示文稿

执行原则：
1. 先分析任务，制定计划（列出步骤）
2. 按步骤依次调用工具收集信息
3. 对收集到的信息进行分析和总结
4. 如果任务要求生成报告，则调用 generate_pdf 或 generate_pptx
5. 最后给出完整的任务结果报告

【重要】每次搜索后，必须对重要的 URL 调用 fetch_url 获取详细内容，不要只依赖搜索摘要。`;
}

async function runTask(task: Task): Promise<void> {
  task.status = "running";
  pushUpdate(task);
  saveTasks();

  try {
    const provider = getAgentProvider();
    const model = getAgentModel();

    if (provider === "openai-compatible") {
      await runTaskWithOpenAI(task, model);
    } else {
      await runTaskWithOllama(task);
    }

    task.status = "completed";
  } catch (err: any) {
    if (task.status === "cancelled") return;
    task.status = "failed";
    addStep(task, {
      type: "error",
      label: "任务执行失败",
      content: err?.message || String(err),
    });
  }

  saveTasks();
  pushUpdate(task);
}

// ─── OpenAI-compatible 执行路径（推荐，支持 Function Calling）────────────────

async function runTaskWithOpenAI(task: Task, model: string): Promise<void> {
  const { getOnlineSettings } = await import("./agent");

  const settings = getOnlineSettings();

  addStep(task, {
    type: "thinking",
    label: "正在分析任务，制定执行计划...",
    content: `任务：${task.prompt}`,
  });

  const messages: CompatibleMessage[] = [
    { role: "system", content: getTaskSystemPrompt() },
    { role: "user", content: task.prompt },
  ];

  // 最多 20 轮工具调用
  for (let round = 0; round < 20; round++) {
    if (task.status === "cancelled") return;

    const response = await invokeOpenAICompatibleChat({
      settings,
      model,
      messages,
      tools: OPENAI_COMPATIBLE_TOOLS,
    });

    const assistantContent = response.content || "";

    // 如果有思考内容（无工具调用时的推理文字），显示出来
    if (assistantContent && response.toolCalls.length === 0) {
      task.result = assistantContent;
      addStep(task, {
        type: "output",
        label: "任务完成，生成最终报告",
        content: assistantContent,
      });

      // 提取生成的文件路径
      const fileMatches = assistantContent.match(
        /[A-Za-z]:[\\\/][^\s，,。\n\r]+\.(pdf|pptx|txt|md)/gi,
      );
      if (fileMatches) {
        task.outputFiles = [...new Set(fileMatches)];
      }
      break;
    }

    if (response.toolCalls.length > 0) {
      // 记录 assistant 消息（含工具调用）
      messages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        if (task.status === "cancelled") return;

        const toolName = toolCall.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          args = {};
        }

        // 生成可读的工具调用记录
        const callLabel = formatToolCallLabel(toolName, args);
        addStep(task, {
          type: "tool_call",
          label: callLabel,
          content: JSON.stringify(args, null, 2),
        });

        const tool = allTools.find((t) => t.name === toolName);
        let resultStr: string;
        if (!tool) {
          resultStr = `工具 ${toolName} 不存在`;
        } else {
          try {
            resultStr = String(await tool.invoke(args));
          } catch (e: any) {
            resultStr = `工具执行失败: ${e?.message || e}`;
          }
        }

        // 截断超长结果避免超 token
        const truncated =
          resultStr.length > 3000
            ? resultStr.slice(0, 3000) + "\n…（内容已截断）"
            : resultStr;

        addStep(task, {
          type: "tool_result",
          label: `${toolName} 返回结果`,
          content: truncated,
        });

        // 收集输出文件路径
        const fileMatch = resultStr.match(
          /[A-Za-z]:[\\\/][^\s\n\r]+\.(pdf|pptx|txt|md)/i,
        );
        if (
          fileMatch &&
          (toolName === "generate_pdf" ||
            toolName === "generate_pptx" ||
            toolName === "write_file")
        ) {
          task.outputFiles = [...new Set([...task.outputFiles, fileMatch[0]])];
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: truncated,
        });
      }

      // 继续下一轮
      continue;
    }

    // 没有工具调用也没有内容，跳出
    break;
  }
}

// ─── Ollama 执行路径（降级，通过 chatWithAgent 代理执行）──────────────────────

async function runTaskWithOllama(task: Task): Promise<void> {
  addStep(task, {
    type: "thinking",
    label: "正在分析任务...",
    content: task.prompt,
  });

  let finalContent = "";

  await chatWithAgent(
    [],
    task.prompt,
    (token) => {
      finalContent += token;
    },
    (toolName, input) => {
      if (task.status === "cancelled") return;
      addStep(task, {
        type: "tool_call",
        label: formatToolCallLabel(toolName, input as Record<string, unknown>),
        content: JSON.stringify(input, null, 2),
      });
    },
    (toolName, result) => {
      if (task.status === "cancelled") return;
      const truncated =
        result.length > 2000 ? result.slice(0, 2000) + "…" : result;
      addStep(task, {
        type: "tool_result",
        label: `${toolName} 结果`,
        content: truncated,
      });
    },
    undefined, // signal
    {
      id: "task-skill",
      name: "任务执行",
      description: "端到端任务执行",
      keywords: [],
      systemPrompt: getTaskSystemPrompt(),
      enabled: true,
      preferredScene: "agent",
      priority: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SkillConfig,
  );

  task.result = finalContent;
  addStep(task, {
    type: "output",
    label: "任务完成",
    content: finalContent,
  });

  // 提取文件路径
  const fileMatches = finalContent.match(
    /[A-Za-z]:[\\\/][^\s，,。\n\r]+\.(pdf|pptx|txt|md)/gi,
  );
  if (fileMatches) {
    task.outputFiles = [...new Set(fileMatches)];
  }
}

// ─── 工具调用标签格式化 ──────────────────────────────────────────────────────

function formatToolCallLabel(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "web_search":
      return `搜索：${String(args.query ?? "").slice(0, 40)}`;
    case "fetch_url":
      return `抓取：${String(args.url ?? "").slice(0, 50)}`;
    case "generate_pdf":
      return `生成 PDF：${String(args.title ?? args.filePath ?? "")}`;
    case "generate_pptx":
      return `生成 PPT：${String(args.title ?? args.filePath ?? "")}`;
    case "write_file":
      return `写入文件：${String(args.filePath ?? "")}`;
    case "read_file":
      return `读取文件：${String(args.filePath ?? "")}`;
    default:
      return `调用工具：${toolName}`;
  }
}
