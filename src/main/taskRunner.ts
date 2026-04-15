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
  | "paused"
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
      if (
        task.status === "running" ||
        task.status === "pending" ||
        task.status === "paused"
      ) {
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

// 暂停恢复的 Promise resolver 映射
const pauseResolvers = new Map<string, () => void>();

/** 若任务处于暂停中，则等待恢复信号 */
async function waitIfPaused(task: Task): Promise<void> {
  if (task.status !== "paused") return;
  await new Promise<void>((resolve) => {
    pauseResolvers.set(task.id, resolve);
  });
}

export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || (task.status !== "running" && task.status !== "paused"))
    return false;
  // 若暂停中需先唤醒 loop，让它检测到 cancelled 后退出
  const resolve = pauseResolvers.get(id);
  if (resolve) {
    pauseResolvers.delete(id);
    resolve();
  }
  task.status = "cancelled";
  task.updatedAt = Date.now();
  pushUpdate(task);
  saveTasks();
  return true;
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "running") return false;
  task.status = "paused";
  task.updatedAt = Date.now();
  pushUpdate(task);
  saveTasks();
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "paused") return false;
  task.status = "running";
  task.updatedAt = Date.now();
  pushUpdate(task);
  saveTasks();
  const resolve = pauseResolvers.get(id);
  if (resolve) {
    pauseResolvers.delete(id);
    resolve();
  }
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

  pushUpdate(task);
  void runTask(task);

  return id;
}

/**
 * 重新运行一个已完成/失败/取消的任务（清空步骤重跑）。
 */
export function rerunTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status === "running" || task.status === "pending")
    return false;

  task.status = "pending";
  task.steps = [];
  task.result = "";
  task.outputFiles = [];
  task.updatedAt = Date.now();

  saveTasks();
  pushUpdate(task);
  void runTask(task);

  return true;
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
  const yearMonth = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  return `你是一个严格按计划执行的任务助手。
【当前真实日期】${dateStr}。所有时间相关操作均以此为准，搜索关键词必须包含具体年月如"${yearMonth}"。

可用工具：
- web_search: 联网搜索（整个任务最多搜索3次，搜索后立即抓取内容，禁止反复搜索）
- fetch_url: 抓取网页详细内容（从搜索结果中选最相关的URL）
- write_file: 写入文件
- read_file: 读取文件
- generate_pdf: 生成PDF报告
- generate_pptx: 生成PPT演示文稿

【执行规则 - 必须严格遵守】
1. 整个任务 web_search 最多调用3次，超出后系统会自动拒绝，请用已有信息直接生成报告
2. 每次搜索后立即用 fetch_url 抓取1-2个最相关URL，不要再次搜索
3. 信息收集完毕后，必须调用 generate_pdf 或 generate_pptx 生成文件
4. 禁止循环搜索，获得搜索结果后直接进入下一计划步骤
5. 整个任务最多执行15个工具调用`;
}

function getPlanPrompt(userPrompt: string): string {
  return `请为以下任务制定一个清晰的执行计划，直接输出编号步骤列表，每步一行，不超过8步。不要解释，不要调用工具，只输出计划。

任务：${userPrompt}

示例格式：
1. 搜索XXX信息
2. 抓取关键页面内容
3. 搜索YYY信息
4. 分析汇总数据
5. 生成PDF/PPT报告`;
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
      // Ollama 同样走 OpenAI-compatible 路径（Ollama 支持 /v1 兼容接口）
      await runTaskWithOpenAI(task, model, {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama",
      });
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

// 带超时的 Promise 包装
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

// ─── OpenAI-compatible 执行路径（推荐，支持 Function Calling）────────────────

async function runTaskWithOpenAI(
  task: Task,
  model: string,
  settingsOverride?: { baseUrl: string; apiKey: string },
): Promise<void> {
  const { getOnlineSettings } = await import("./agent");
  const baseSettings = getOnlineSettings();
  const settings = settingsOverride
    ? {
        ...baseSettings,
        baseUrl: settingsOverride.baseUrl,
        apiKey: settingsOverride.apiKey,
      }
    : baseSettings;

  // ── 阶段一：先让模型输出执行计划（不带工具）──────────────────────────────
  const planResponse = await invokeOpenAICompatibleChat({
    settings,
    model,
    messages: [
      { role: "system", content: getTaskSystemPrompt() },
      { role: "user", content: getPlanPrompt(task.prompt) },
    ],
    // 不传 tools，强制输出纯文本计划
  });

  const plan =
    planResponse.content?.trim() || "（模型未输出计划，将直接执行任务）";
  addStep(task, {
    type: "plan",
    label: "执行计划",
    content: plan,
  });

  // ── 阶段二：带工具执行，携带计划上下文 ──────────────────────────────────
  const messages: CompatibleMessage[] = [
    { role: "system", content: getTaskSystemPrompt() },
    {
      role: "user",
      content: `任务：${task.prompt}\n\n已制定的执行计划：\n${plan}\n\n请严格按照上述计划，依次调用工具执行每个步骤。每个步骤完成后立即进入下一步，不要重复已完成的步骤。`,
    },
  ];

  // 限制 web_search 调用次数
  let searchCallCount = 0;
  const MAX_SEARCH_CALLS = 3;
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = 15;

  for (let round = 0; round < 20; round++) {
    await waitIfPaused(task);
    if (task.status === "cancelled") return;
    if (toolCallCount >= MAX_TOOL_CALLS) {
      addStep(task, {
        type: "thinking",
        label: "已达工具调用上限，整理输出结果",
        content: `已执行 ${toolCallCount} 次工具调用，开始整理最终结果。`,
      });
      // 让模型总结已有内容
      messages.push({
        role: "user",
        content:
          "已收集足够信息，请立即整理并生成最终报告（调用generate_pdf或generate_pptx），或直接输出总结文本。",
      });
    }

    const response = await withTimeout(
      invokeOpenAICompatibleChat({
        settings,
        model,
        messages,
        tools:
          toolCallCount < MAX_TOOL_CALLS ? OPENAI_COMPATIBLE_TOOLS : undefined,
      }),
      120_000,
      "模型响应",
    );

    const assistantContent = response.content || "";

    if (assistantContent && response.toolCalls.length === 0) {
      task.result = assistantContent;
      addStep(task, {
        type: "output",
        label: "任务完成",
        content: assistantContent,
      });
      const fileMatches = assistantContent.match(
        /[A-Za-z]:[\\\/][^\s，,。\n\r]+\.(pdf|pptx|txt|md)/gi,
      );
      if (fileMatches) {
        task.outputFiles = [...new Set(fileMatches)];
      }
      break;
    }

    if (response.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        await waitIfPaused(task);
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

        // 限制 web_search 调用次数
        if (toolName === "web_search") {
          if (searchCallCount >= MAX_SEARCH_CALLS) {
            const query = String(args.query || args.q || JSON.stringify(args));
            const skipMsg = `已达搜索上限（最多${MAX_SEARCH_CALLS}次），跳过搜索"${query}"。请直接使用已收集的信息生成最终报告。`;
            addStep(task, {
              type: "thinking",
              label: "已达搜索上限",
              content: skipMsg,
            });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: skipMsg,
            });
            continue;
          }
          searchCallCount++;
        }

        toolCallCount++;
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
            resultStr = String(
              await withTimeout(tool.invoke(args), 45_000, `工具 ${toolName}`),
            );
          } catch (e: any) {
            resultStr = `工具执行失败: ${e?.message || e}`;
          }
        }

        const truncated =
          resultStr.length > 3000
            ? resultStr.slice(0, 3000) + "\n…（内容已截断）"
            : resultStr;

        addStep(task, {
          type: "tool_result",
          label: `${toolName} 返回结果`,
          content: truncated,
        });

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

      continue;
    }

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
