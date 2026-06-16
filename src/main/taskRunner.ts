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
import { executeTool } from "./runtime/ToolExecutor";
import { getDefaultArtifactDir } from "./tools/policy";
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
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
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
  checkpoint?: {
    node: string;
    round: number;
    toolCallCount: number;
    updatedAt: number;
    canResume: boolean;
  };
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

function isTaskCancelled(task: Task): boolean {
  return task.status === "cancelled";
}

function updateCheckpoint(
  task: Task,
  patch: Partial<NonNullable<Task["checkpoint"]>>,
): void {
  task.checkpoint = {
    node: task.checkpoint?.node ?? "start",
    round: task.checkpoint?.round ?? 0,
    toolCallCount: task.checkpoint?.toolCallCount ?? 0,
    canResume: true,
    ...patch,
    updatedAt: Date.now(),
  };
  task.updatedAt = Date.now();
}

function loadTasks(): void {
  try {
    const file = getTasksFile();
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Task[];
    for (const task of data) {
      // 重启后保留上下文，不直接判失败，方便用户查看并重新恢复。
      if (
        task.status === "running" ||
        task.status === "pending" ||
        task.status === "paused" ||
        task.status === "waiting_for_approval" ||
        task.status === "waiting_for_input"
      ) {
        task.status = "blocked";
        updateCheckpoint(task, { canResume: false });
        task.steps.push({
          id: uuidv4(),
          type: "error",
          label: "应用重启，任务已暂停在断点",
          content:
            "应用重启导致任务执行中断。已保留已有步骤和最近 checkpoint，可点击重新运行继续完成任务。",
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
  if (
    !task ||
    ![
      "running",
      "paused",
      "waiting_for_approval",
      "waiting_for_input",
      "blocked",
    ].includes(task.status)
  )
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
  if (!task || (task.status !== "paused" && task.status !== "blocked"))
    return false;
  task.status = "running";
  task.updatedAt = Date.now();
  pushUpdate(task);
  saveTasks();
  if (task.status === "running" && task.checkpoint?.canResume === false) {
    addStep(task, {
      type: "thinking",
      label: "从保留上下文继续执行",
      content:
        "当前版本会保留历史步骤后继续执行任务；精确节点级断点续跑将在任务图 Runtime 中启用。",
    });
    void runTask(task);
    return true;
  }
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
    checkpoint: {
      node: "created",
      round: 0,
      toolCallCount: 0,
      updatedAt: now,
      canResume: true,
    },
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
  updateCheckpoint(task, {
    node: "rerun",
    round: 0,
    toolCallCount: 0,
    canResume: true,
  });
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
5. 整个任务最多执行15个工具调用
6. 如果任务主题是某个行业/品类近几个月动态，必须先拆成“品牌/系列 + 发布 + 参数/图片 + 年月”的检索词，禁止直接搜索过宽泛的大句子
7. 如果任务是手机新品汇总，优先关注手机厂商官网、发布会稿件和主流科技媒体；忽略政策、节假日、日历、旅游、泛新闻等明显无关结果
8. 在生成报告前，至少核对每个核心结论对应的抓取页面是否真的提到该机型名称、发布时间、参数或图片来源`;
}

function getPlanPrompt(userPrompt: string): string {
  return `请为以下任务制定一个清晰的执行计划，直接输出编号步骤列表，每步一行，不超过8步。不要解释，不要调用工具，只输出计划。

如果任务是在整理最近几个月某行业新品/活动：
- 先拆解信息维度（品牌、时间范围、型号、参数、图片来源）
- 搜索词要短且具体，不要直接复述整段任务
- 优先安排“搜索 -> 抓取 -> 校对 -> 生成文档”的节奏

任务：${userPrompt}

示例格式：
1. 搜索XXX信息
2. 抓取关键页面内容
3. 搜索YYY信息
4. 分析汇总数据
5. 生成PDF/PPT报告`;
}

function buildTaskSystemPrompt(taskPrompt: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const yearMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const allowFileOutput = taskNeedsFileOutput(taskPrompt);
  const artifactTools = allowFileOutput
    ? `- generate_pdf: generate a PDF report only when the user explicitly asks for PDF/report output
- generate_pptx: generate a PPTX deck only when the user explicitly asks for PPT/slides/presentation output`
    : `- Do not generate PDF or PPT files for this task unless the user explicitly asks for them.`;
  const artifactRule = allowFileOutput
    ? "3. Generate PDF/PPT/Markdown style deliverables only when the user explicitly requests them."
    : "3. This task should stay in plain text. Do not call generate_pdf or generate_pptx.";

  return `You are a disciplined task execution assistant.
Current date: ${dateStr}. Any time-sensitive reasoning must use this as the reference date, and search queries should include a concrete year/month such as ${yearMonth}.

Available tools:
- web_search: search the web only when needed, and avoid redundant queries.
- fetch_url: fetch the detailed content of the most relevant URLs.
- write_file: write a local file only when necessary.
- read_file: read a local file when needed.
${artifactTools}

Execution rules:
1. After searching, fetch the most relevant 1-2 URLs instead of looping on search.
2. Avoid repeated tool calls for the same purpose. Move on once enough evidence is collected.
${artifactRule}
4. If the task is a normal conversational request, answer directly in text instead of manufacturing files.
5. For research tasks, keep conclusions grounded in collected evidence.
6. For recent phone-launch tasks, prefer official vendor sites and major tech media, and verify launch date, specs, and source references before summarizing.`;
}

function buildTaskPlanPrompt(userPrompt: string): string {
  const needsFileOutput = taskNeedsFileOutput(userPrompt);
  const finalStep = needsFileOutput
    ? "5. Organize the result and generate the requested file only if the user explicitly asked for one"
    : "5. Output the final answer directly in plain text";

  return `Create a concise execution plan for the task below. Output only a numbered list with at most 6 steps, one step per line. Do not explain. Do not call tools.

For research or organization tasks:
- break the request into clear information dimensions
- keep search queries short and specific
- prefer the rhythm: search -> fetch -> verify -> summarize

Task: ${userPrompt}

Example format:
1. Search key information
2. Fetch the most relevant pages
3. Verify the main facts
4. Summarize the findings
${finalStep}`;
}
function isPhoneLaunchTask(prompt: string): boolean {
  return /(手机|新机|发布会|发布的新手机|机型|参数|配置|图片|真机图|渲染图|厂商)/i.test(
    prompt,
  );
}

function isFetchResultSuccessful(result: string): boolean {
  return !/^网页抓取失败[:：]/.test(result) && result.includes("正文:");
}

function extractMatchedPhoneBrands(text: string): string[] {
  const brandPatterns: Array<[string, RegExp]> = [
    ["vivo", /\bvivo\b|vivo|iqoo|iQOO/i],
    ["OPPO", /\boppo\b|oppo|一加|oneplus|realme/i],
    ["华为", /华为|\bhuawei\b/i],
    ["荣耀", /荣耀|\bhonor\b/i],
    ["小米", /小米|\bxiaomi\b|\bredmi\b/i],
    ["魅族", /魅族|\bmeizu\b/i],
    ["努比亚", /努比亚|\bnubia\b/i],
  ];

  return brandPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([brand]) => brand);
}

function hasPhoneTaskEvidence(
  fetchSuccessCount: number,
  matchedBrands: Set<string>,
): boolean {
  return fetchSuccessCount >= 4 && matchedBrands.size >= 3;
}

function containsPlaceholderContent(text: string): boolean {
  return /(暂无具体信息|暂时无具体信息|暂无信息|待补充|后续补充)/.test(text);
}

type PhoneEvidenceItem = {
  brand: string;
  title: string;
  url: string;
  excerpt: string;
};

function extractSearchResultUrls(result: string): string[] {
  const urls = result.match(/https?:\/\/[^\s\u4e00-\u9fa5<>")]+/g) || [];
  return [...new Set(urls)].filter((url) => {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol);
    } catch {
      return false;
    }
  });
}

function splitSearchResultEntries(result: string): Array<{
  title: string;
  url: string;
  body: string;
}> {
  return result
    .split(/\n\n(?=\d+\.)/)
    .map((block) => block.trim())
    .filter((block) => /^\d+\./.test(block))
    .map((block) => {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const title = lines[0]?.replace(/^\d+\.\s*/, "") || "";
      const url = lines.find((line) => /^https?:\/\//.test(line)) || "";
      return {
        title,
        url,
        body: lines.join(" "),
      };
    })
    .filter((entry) => Boolean(entry.url));
}

function scorePhoneSearchEntry(
  entry: { title: string; url: string; body: string },
  query: string,
): number {
  const haystack = `${entry.title} ${entry.body} ${entry.url}`.toLowerCase();
  let score = 0;

  if (
    /(gov\.cn|mwr\.gov\.cn|holiday|日历|节假日|政策|国务院|农历|放假)/i.test(
      haystack,
    )
  ) {
    return -100;
  }

  if (
    /(ithome|mydrivers|zol|pconline|cnmo|techweb|gsmarena|91mobiles|sina\.com\.cn|163\.com|sohu\.com|oppo\.com|vivo\.com|huawei\.com|honor\.com|mi\.com|xiaomi\.com|iqoo\.com|oneplus\.com|realme\.com)/i.test(
      haystack,
    )
  ) {
    score += 6;
  }

  if (
    /(手机|新机|发布|发布会|参数|配置|影像|图片|真机图|渲染图|售价|开售)/i.test(
      haystack,
    )
  ) {
    score += 4;
  }

  for (const brand of extractMatchedPhoneBrands(
    `${query} ${entry.title} ${entry.body}`,
  )) {
    if (haystack.includes(brand.toLowerCase()) || entry.body.includes(brand)) {
      score += 3;
    }
  }

  return score;
}

function extractRelevantPhoneUrls(result: string, query: string): string[] {
  const scoredEntries = splitSearchResultEntries(result)
    .map((entry) => ({
      entry,
      score: scorePhoneSearchEntry(entry, query),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredEntries.length > 0) {
    return [...new Set(scoredEntries.map((item) => item.entry.url))];
  }

  return [];
}

function taskNeedsPpt(prompt: string): boolean {
  return /(ppt|pptx|演示文稿|幻灯片)/i.test(prompt);
}

function taskNeedsDocument(prompt: string): boolean {
  return /(文档|报告|总结|汇总|markdown|md|pdf)/i.test(prompt);
}

function taskNeedsMarkdown(prompt: string): boolean {
  return /(markdown|\.md|(^|\s)md(\s|$))/i.test(prompt);
}

function taskNeedsFileOutput(prompt: string): boolean {
  return (
    taskNeedsPpt(prompt) ||
    taskNeedsDocument(prompt) ||
    taskNeedsMarkdown(prompt)
  );
}

function getTaskToolDefinitions(
  prompt: string,
): typeof OPENAI_COMPATIBLE_TOOLS {
  const allowArtifactTools = taskNeedsFileOutput(prompt);
  if (allowArtifactTools) return OPENAI_COMPATIBLE_TOOLS;

  return OPENAI_COMPATIBLE_TOOLS.filter((tool) => {
    const name = tool.function.name;
    return name !== "generate_pdf" && name !== "generate_pptx";
  });
}
function sanitizeArtifactBaseName(input: string): string {
  const safe = input
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return safe || "任务报告";
}

function extractExcerptFromFetchResult(result: string): string {
  const matched = result.match(/正文:\s*([\s\S]+)/);
  const raw = matched?.[1] ?? result;
  return raw.replace(/\s+/g, " ").trim().slice(0, 280);
}

function extractTitleFromFetchResult(result: string): string {
  const matched = result.match(/网页标题[:：]\s*(.+)/);
  return matched?.[1]?.trim() || "来源页面";
}

function extractUrlFromFetchResult(result: string): string {
  const matched = result.match(/链接[:：]\s*(https?:\/\/[^\s]+)/);
  return matched?.[1]?.trim() || "";
}

function collectPhoneEvidenceFromFetchResult(
  result: string,
): PhoneEvidenceItem[] {
  const title = extractTitleFromFetchResult(result);
  const url = extractUrlFromFetchResult(result);
  const excerpt = extractExcerptFromFetchResult(result);
  const brands = extractMatchedPhoneBrands(`${title}\n${excerpt}`);

  if (!url || brands.length === 0 || !excerpt) {
    return [];
  }

  return brands.map((brand) => ({
    brand,
    title,
    url,
    excerpt,
  }));
}

function hasUsablePhoneEvidence(evidenceItems: PhoneEvidenceItem[]): boolean {
  const uniqueBrands = new Set(evidenceItems.map((item) => item.brand));
  const uniqueUrls = new Set(evidenceItems.map((item) => item.url));
  return uniqueBrands.size >= 2 && uniqueUrls.size >= 2;
}

function buildPhoneMarkdownReport(
  prompt: string,
  taskResult: string,
  evidenceItems: PhoneEvidenceItem[],
): { title: string; content: string } {
  const now = new Date();
  const title = `${getRecentMonthRangeText(now)} 中国手机新品整理`;
  const lines: string[] = [
    `# ${title}`,
    "",
    `- 任务：${prompt}`,
    `- 生成时间：${now.toLocaleString("zh-CN")}`,
    `- 统计范围：最近三个月内中国手机厂商发布的新机信息`,
    "",
  ];

  if (taskResult.trim()) {
    lines.push("## 结论摘要", "", taskResult.trim(), "");
  }

  const grouped = new Map<string, PhoneEvidenceItem[]>();
  for (const item of evidenceItems) {
    const list = grouped.get(item.brand) ?? [];
    if (!list.some((existing) => existing.url === item.url)) {
      list.push(item);
    }
    grouped.set(item.brand, list);
  }

  if (grouped.size > 0) {
    lines.push("## 分品牌信息");
    for (const [brand, items] of grouped) {
      lines.push("", `### ${brand}`);
      for (const item of items.slice(0, 2)) {
        lines.push(`- 标题：${item.title}`);
        lines.push(`- 摘要：${item.excerpt}`);
        lines.push(`- 来源：${item.url}`);
      }
    }
    lines.push("");
  }

  if (evidenceItems.length > 0) {
    lines.push("## 来源列表", "");
    for (const item of evidenceItems.slice(0, 12)) {
      lines.push(`- ${item.brand}｜${item.title}｜${item.url}`);
    }
  }

  return { title, content: lines.join("\n") };
}

function buildPhoneSlides(
  reportTitle: string,
  taskResult: string,
  evidenceItems: PhoneEvidenceItem[],
): Array<{ title: string; content: string }> {
  const slides: Array<{ title: string; content: string }> = [];
  const summaryLines = taskResult
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  slides.push({
    title: "任务摘要",
    content:
      summaryLines.length > 0
        ? summaryLines
            .map((line) => `- ${line.replace(/^[-*]\s*/, "")}`)
            .join("\n")
        : "- 汇总最近三个月中国手机厂商发布的新机\n- 重点保留发布时间、参数、图片来源\n- 结果基于公开网页抓取整理",
  });

  const grouped = new Map<string, PhoneEvidenceItem[]>();
  for (const item of evidenceItems) {
    const list = grouped.get(item.brand) ?? [];
    if (!list.some((existing) => existing.url === item.url)) {
      list.push(item);
    }
    grouped.set(item.brand, list);
  }

  for (const [brand, items] of grouped) {
    const lines: string[] = [];
    for (const item of items.slice(0, 2)) {
      lines.push(`- ${item.title}`);
      lines.push(`- ${item.excerpt}`);
      lines.push(`- 来源：${item.url}`);
    }
    slides.push({
      title: `${brand} 新机信息`,
      content: lines.join("\n"),
    });
  }

  slides.push({
    title: "说明",
    content: `- 标题：${reportTitle}\n- 数据来源：厂商官网与主流科技媒体公开网页\n- 本次输出包含 Markdown 文档与 PPT`,
  });

  return slides.slice(0, 8);
}

async function ensureTaskArtifacts(
  task: Task,
  evidenceItems: PhoneEvidenceItem[],
): Promise<void> {
  if (task.outputFiles.length > 0) return;
  if (!taskNeedsPpt(task.prompt) && !taskNeedsMarkdown(task.prompt)) return;

  if (
    isPhoneLaunchTask(task.prompt) &&
    !hasUsablePhoneEvidence(evidenceItems)
  ) {
    throw new Error(
      "手机新品数据不足，未生成 PPT。请继续补充有效品牌、参数和图片来源后再生成。",
    );
  }

  const baseDir = getDefaultArtifactDir();
  const baseName = sanitizeArtifactBaseName(task.title);
  const { title, content } = buildPhoneMarkdownReport(
    task.prompt,
    task.result,
    evidenceItems,
  );

  if (taskNeedsMarkdown(task.prompt)) {
    const docPath = join(baseDir, `${baseName}.md`);
    const docResult = (
      await executeTool(
        "write_file",
        { filePath: docPath, content },
        { timeoutMs: 45_000 },
      )
    ).result;
    addStep(task, {
      type: "tool_result",
      label: "自动补生成文档",
      content: docResult,
    });
    task.outputFiles = [...new Set([...task.outputFiles, docPath])];
  }

  if (taskNeedsPpt(task.prompt)) {
    const pptPath = join(baseDir, `${baseName}.pptx`);
    const pptResult = (
      await executeTool(
        "generate_pptx",
        {
          filePath: pptPath,
          title,
          slides: buildPhoneSlides(title, task.result, evidenceItems),
        },
        { timeoutMs: 45_000 },
      )
    ).result;
    addStep(task, {
      type: "tool_result",
      label: "自动补生成 PPT",
      content: pptResult,
    });
    if (/^生成 PPT 失败[:：]/.test(pptResult)) {
      throw new Error(pptResult);
    }
    task.outputFiles = [...new Set([...task.outputFiles, pptPath])];
  }
}

const PHONE_TASK_BRANDS = [
  "华为",
  "荣耀",
  "小米",
  "vivo",
  "OPPO",
  "iQOO",
  "一加",
  "realme",
];

const PHONE_TASK_BRAND_SEARCH_CONFIGS = [
  {
    brand: "华为",
    aliases: "Huawei",
    sites:
      "(site:huawei.com OR site:consumer.huawei.com OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "荣耀",
    aliases: "HONOR",
    sites:
      "(site:honor.com OR site:honor.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "小米",
    aliases: "Xiaomi Redmi",
    sites:
      "(site:mi.com OR site:xiaomi.com OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "vivo",
    aliases: "vivo",
    sites:
      "(site:vivo.com OR site:vivo.com.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "OPPO",
    aliases: "OPPO",
    sites:
      "(site:oppo.com OR site:oppo.com.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "iQOO",
    aliases: "iQOO",
    sites:
      "(site:iqoo.com OR site:iqoo.com.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "一加",
    aliases: "OnePlus",
    sites:
      "(site:oneplus.com OR site:oneplus.com.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
  {
    brand: "realme",
    aliases: "realme 真我",
    sites:
      "(site:realme.com OR site:realme.com.cn OR site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)",
  },
];

function getRecentMonthRangeText(now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);

  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月至${end.getMonth() + 1}月`;
  }

  return `${start.getFullYear()}年${start.getMonth() + 1}月至${end.getFullYear()}年${end.getMonth() + 1}月`;
}

function buildPhoneTaskSearchQueries(prompt: string): string[] {
  const monthText = getRecentMonthRangeText();
  const wantsImages = /(图片|配图|真机图|渲染图|海报)/i.test(prompt);
  const suffix = wantsImages ? "发布 参数 图片" : "发布 参数 配置";

  return PHONE_TASK_BRANDS.map(
    (brand) => `${monthText} ${brand} 手机 新机 ${suffix}`,
  );
}

function buildPhoneTaskSourceFocusedQueries(prompt: string): string[] {
  const monthText = getRecentMonthRangeText();
  const wantsImages = /(图片|配图|真机图|渲染图|海报)/i.test(prompt);
  const suffix = wantsImages ? "发布 参数 图片" : "发布 参数 配置";

  return PHONE_TASK_BRAND_SEARCH_CONFIGS.map(
    ({ brand, aliases, sites }) =>
      `${monthText} ${brand} ${aliases} 手机 新机 ${suffix} ${sites}`,
  );
}

function buildPhoneTaskMediaQueries(prompt: string): string[] {
  const monthText = getRecentMonthRangeText();
  const wantsImages = /(图片|配图|真机图|渲染图|海报)/i.test(prompt);
  const suffix = wantsImages ? "发布 参数 图片" : "发布 参数 配置";
  const preferredSites =
    "(site:ithome.com OR site:zol.com.cn OR site:pconline.com.cn)";

  return PHONE_TASK_BRAND_SEARCH_CONFIGS.map(
    ({ brand, aliases }) =>
      `${monthText} ${brand} ${aliases} 手机 新机 ${suffix} ${preferredSites}`,
  );
}

const PHONE_TASK_BRAND_TAG_URLS = [
  "https://www.ithome.com/tag/huawei/",
  "https://www.ithome.com/tag/honor/",
  "https://www.ithome.com/tag/xiaomi/",
  "https://www.ithome.com/tag/vivo/",
  "https://www.ithome.com/tag/oppo/",
  "https://www.ithome.com/tag/iqoo/",
  "https://www.ithome.com/tag/oneplus/",
  "https://www.ithome.com/tag/realme/",
];

async function runTask(task: Task): Promise<void> {
  task.status = "running";
  updateCheckpoint(task, { node: "running", canResume: true });
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
    updateCheckpoint(task, { node: "completed", canResume: false });
  } catch (err: any) {
    if (isTaskCancelled(task)) return;
    task.status = "failed";
    updateCheckpoint(task, { node: "failed", canResume: true });
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
      { role: "system", content: buildTaskSystemPrompt(task.prompt) },
      { role: "user", content: buildTaskPlanPrompt(task.prompt) },
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
  updateCheckpoint(task, {
    node: "plan",
    round: 0,
    toolCallCount: 0,
    canResume: true,
  });

  // ── 阶段二：带工具执行，携带计划上下文 ──────────────────────────────────
  const availableTools = getTaskToolDefinitions(task.prompt);

  const messages: CompatibleMessage[] = [
    { role: "system", content: buildTaskSystemPrompt(task.prompt) },
    {
      role: "user",
      content: `任务：${task.prompt}\n\n已制定的执行计划：\n${plan}\n\n请严格按照上述计划，依次调用工具执行每个步骤。每个步骤完成后立即进入下一步，不要重复已完成的步骤。`,
    },
  ];

  // 限制 web_search 调用次数
  let searchCallCount = 0;
  const isPhoneTask = isPhoneLaunchTask(task.prompt);
  const MAX_SEARCH_CALLS = isPhoneTask ? 8 : 3;
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = isPhoneTask ? 24 : 15;
  let fetchSuccessCount = 0;
  const matchedPhoneBrands = new Set<string>();
  const autoFetchedUrls = new Set<string>();
  const phoneEvidenceItems: PhoneEvidenceItem[] = [];

  const collectPhoneTaskEvidence = async () => {
    const queries = buildPhoneTaskMediaQueries(task.prompt);

    addStep(task, {
      type: "thinking",
      label: "按品牌拆分采集手机新品信息",
      content: `将按以下品牌分别搜索并抓取页面：${PHONE_TASK_BRANDS.join("、")}`,
    });

    for (const url of PHONE_TASK_BRAND_TAG_URLS) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        break;
      }

      autoFetchedUrls.add(url);
      toolCallCount += 1;
      updateCheckpoint(task, {
        node: "bootstrap:brand_tag_fetch",
        round: 0,
        toolCallCount,
        canResume: true,
      });

      addStep(task, {
        type: "tool_call",
        label: `品牌聚合页抓取: ${url.slice(0, 60)}`,
        content: JSON.stringify({ url, maxLength: 6000 }, null, 2),
      });

      let fetchResult = "";
      try {
        fetchResult = (
          await executeTool(
            "fetch_url",
            { url, maxLength: 6000 },
            { timeoutMs: 45_000 },
          )
        ).result;
      } catch (error: any) {
        fetchResult = `网页抓取失败: ${error?.message || error}`;
      }

      if (isFetchResultSuccessful(fetchResult)) {
        fetchSuccessCount += 1;
        for (const brand of extractMatchedPhoneBrands(fetchResult)) {
          matchedPhoneBrands.add(brand);
        }
        phoneEvidenceItems.push(
          ...collectPhoneEvidenceFromFetchResult(fetchResult),
        );
      }

      addStep(task, {
        type: "tool_result",
        label: "fetch_url 返回结果",
        content:
          fetchResult.length > 3000
            ? fetchResult.slice(0, 3000) + "\n…（内容已截断）"
            : fetchResult,
      });

      messages.push({
        role: "tool",
        tool_call_id: `bootstrap:brand_tag_fetch:${toolCallCount}`,
        content: fetchResult,
      });

      if (hasUsablePhoneEvidence(phoneEvidenceItems)) {
        return;
      }
    }

    for (const query of queries) {
      if (
        searchCallCount >= MAX_SEARCH_CALLS ||
        toolCallCount >= MAX_TOOL_CALLS
      ) {
        break;
      }

      searchCallCount += 1;
      toolCallCount += 1;
      updateCheckpoint(task, {
        node: "bootstrap:web_search",
        round: 0,
        toolCallCount,
        canResume: true,
      });

      addStep(task, {
        type: "tool_call",
        label: `搜索：${query.slice(0, 40)}`,
        content: JSON.stringify({ query, maxResults: 5 }, null, 2),
      });

      let searchResult = "";
      try {
        searchResult = (
          await executeTool(
            "web_search",
            { query, maxResults: 5 },
            { timeoutMs: 45_000 },
          )
        ).result;
      } catch (error: any) {
        searchResult = `工具执行失败: ${error?.message || error}`;
      }

      addStep(task, {
        type: "tool_result",
        label: "web_search 返回结果",
        content:
          searchResult.length > 3000
            ? searchResult.slice(0, 3000) + "\n…（内容已截断）"
            : searchResult,
      });

      messages.push({
        role: "tool",
        tool_call_id: `bootstrap:web_search:${searchCallCount}`,
        content: searchResult,
      });

      const firstUrl = extractRelevantPhoneUrls(searchResult, query).find(
        (url) => !autoFetchedUrls.has(url),
      );

      if (!firstUrl || toolCallCount >= MAX_TOOL_CALLS) {
        continue;
      }

      autoFetchedUrls.add(firstUrl);
      toolCallCount += 1;
      updateCheckpoint(task, {
        node: "bootstrap:fetch_url",
        round: 0,
        toolCallCount,
        canResume: true,
      });

      addStep(task, {
        type: "tool_call",
        label: `自动抓取：${firstUrl.slice(0, 60)}`,
        content: JSON.stringify({ url: firstUrl, maxLength: 6000 }, null, 2),
      });

      let fetchResult = "";
      try {
        fetchResult = (
          await executeTool(
            "fetch_url",
            { url: firstUrl, maxLength: 6000 },
            { timeoutMs: 45_000 },
          )
        ).result;
      } catch (error: any) {
        fetchResult = `网页抓取失败: ${error?.message || error}`;
      }

      if (isFetchResultSuccessful(fetchResult)) {
        fetchSuccessCount += 1;
        for (const brand of extractMatchedPhoneBrands(fetchResult)) {
          matchedPhoneBrands.add(brand);
        }
        phoneEvidenceItems.push(
          ...collectPhoneEvidenceFromFetchResult(fetchResult),
        );
      }

      addStep(task, {
        type: "tool_result",
        label: "fetch_url 返回结果",
        content:
          fetchResult.length > 3000
            ? fetchResult.slice(0, 3000) + "\n…（内容已截断）"
            : fetchResult,
      });

      messages.push({
        role: "tool",
        tool_call_id: `bootstrap:fetch_url:${searchCallCount}`,
        content: fetchResult,
      });
    }
  };

  if (isPhoneTask) {
    await collectPhoneTaskEvidence();
    if (
      !hasUsablePhoneEvidence(phoneEvidenceItems) &&
      searchCallCount >= MAX_SEARCH_CALLS
    ) {
      throw new Error(
        `手机新品信息采集失败：未抓取到足够有效页面。当前有效页面 ${fetchSuccessCount} 个，品牌覆盖 ${matchedPhoneBrands.size} 个。请检查搜索源或缩小任务范围后重试。`,
      );
    }
  }

  for (let round = 0; round < 20; round++) {
    await waitIfPaused(task);
    if (isTaskCancelled(task)) return;
    updateCheckpoint(task, {
      node: "execute",
      round,
      toolCallCount,
      canResume: true,
    });
    if (toolCallCount >= MAX_TOOL_CALLS) {
      addStep(task, {
        type: "thinking",
        label: "Tool limit reached, preparing final output",
        content: `Executed ${toolCallCount} tool calls, preparing the final response.`,
      });
      messages.push({
        role: "user",
        content: taskNeedsFileOutput(task.prompt)
          ? "Enough information has been collected. Organize the result, and only generate a file if the user explicitly requested one."
          : "Enough information has been collected. Output the final answer directly in plain text and do not generate PDF or PPT.",
      });
    }

    const response = await withTimeout(
      invokeOpenAICompatibleChat({
        settings,
        model,
        messages,
        tools: toolCallCount < MAX_TOOL_CALLS ? availableTools : undefined,
      }),
      120_000,
      "模型响应",
    );

    const assistantContent = response.content || "";

    if (assistantContent && response.toolCalls.length === 0) {
      if (
        isPhoneTask &&
        (containsPlaceholderContent(assistantContent) ||
          !hasPhoneTaskEvidence(fetchSuccessCount, matchedPhoneBrands)) &&
        (searchCallCount < MAX_SEARCH_CALLS || toolCallCount < MAX_TOOL_CALLS)
      ) {
        addStep(task, {
          type: "thinking",
          label: "证据不足，继续补充手机新品信息",
          content: `当前仅抓取 ${fetchSuccessCount} 个有效页面，覆盖 ${matchedPhoneBrands.size} 个品牌，且输出仍包含占位内容。继续搜索并抓取更具体的机型发布时间、参数和图片来源。`,
        });
        messages.push({
          role: "user",
          content:
            "当前证据不足，且回答仍有占位内容。请继续搜索并抓取更具体的手机新品页面，至少覆盖多个品牌，并补齐发布时间、参数和图片来源后再生成文档。",
        });
        continue;
      }

      if (
        isPhoneTask &&
        (containsPlaceholderContent(assistantContent) ||
          !hasPhoneTaskEvidence(fetchSuccessCount, matchedPhoneBrands))
      ) {
        throw new Error(
          `手机新品证据不足，停止生成。当前有效页面 ${fetchSuccessCount} 个，品牌覆盖 ${matchedPhoneBrands.size} 个。`,
        );
      }

      task.result = assistantContent;
      await ensureTaskArtifacts(task, phoneEvidenceItems);
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
        if (isTaskCancelled(task)) return;

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
        updateCheckpoint(task, {
          node: `tool:${toolName}`,
          round,
          toolCallCount,
          canResume: true,
        });
        const callLabel = formatToolCallLabel(toolName, args);
        addStep(task, {
          type: "tool_call",
          label: callLabel,
          content: JSON.stringify(args, null, 2),
        });

        let resultStr: string;
        try {
          resultStr = (await executeTool(toolName, args, { timeoutMs: 45_000 }))
            .result;
        } catch (e: any) {
          resultStr = `工具执行失败: ${e?.message || e}`;
        }

        if (toolName === "web_search" && isPhoneTask) {
          const candidateUrls = extractRelevantPhoneUrls(
            resultStr,
            String(args.query || ""),
          ).filter((url) => !autoFetchedUrls.has(url));

          for (const url of candidateUrls.slice(0, 2)) {
            autoFetchedUrls.add(url);
            toolCallCount++;
            updateCheckpoint(task, {
              node: `tool:auto-fetch:${toolName}`,
              round,
              toolCallCount,
              canResume: true,
            });

            addStep(task, {
              type: "tool_call",
              label: `自动抓取：${url.slice(0, 60)}`,
              content: JSON.stringify({ url, maxLength: 6000 }, null, 2),
            });

            let autoFetchResult = "";
            try {
              autoFetchResult = (
                await executeTool(
                  "fetch_url",
                  { url, maxLength: 6000 },
                  { timeoutMs: 45_000 },
                )
              ).result;
            } catch (error: any) {
              autoFetchResult = `网页抓取失败: ${error?.message || error}`;
            }

            if (isFetchResultSuccessful(autoFetchResult)) {
              fetchSuccessCount += 1;
              for (const brand of extractMatchedPhoneBrands(autoFetchResult)) {
                matchedPhoneBrands.add(brand);
              }
              phoneEvidenceItems.push(
                ...collectPhoneEvidenceFromFetchResult(autoFetchResult),
              );
            }

            const autoFetchTruncated =
              autoFetchResult.length > 3000
                ? autoFetchResult.slice(0, 3000) + "\n…（内容已截断）"
                : autoFetchResult;

            addStep(task, {
              type: "tool_result",
              label: "fetch_url 返回结果",
              content: autoFetchTruncated,
            });

            messages.push({
              role: "tool",
              tool_call_id: `${toolCall.id}:auto-fetch:${url}`,
              content: autoFetchTruncated,
            });
          }
        }

        if (toolName === "fetch_url" && isFetchResultSuccessful(resultStr)) {
          fetchSuccessCount += 1;
          for (const brand of extractMatchedPhoneBrands(resultStr)) {
            matchedPhoneBrands.add(brand);
          }
          phoneEvidenceItems.push(
            ...collectPhoneEvidenceFromFetchResult(resultStr),
          );
        }

        if (
          isPhoneTask &&
          (toolName === "generate_pdf" || toolName === "generate_pptx") &&
          !hasPhoneTaskEvidence(fetchSuccessCount, matchedPhoneBrands)
        ) {
          resultStr = `证据不足，暂不允许生成文档。当前仅抓取 ${fetchSuccessCount} 个有效页面，覆盖 ${matchedPhoneBrands.size} 个品牌。请继续搜索并抓取更具体的机型发布时间、参数与图片来源。`;
          addStep(task, {
            type: "error",
            label: "证据不足，停止生成",
            content: resultStr,
          });
          throw new Error(resultStr);
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

  await ensureTaskArtifacts(task, phoneEvidenceItems);

  if (!task.result.trim() && task.outputFiles.length > 0) {
    task.result = `任务已完成，已生成文件：\n${task.outputFiles.join("\n")}`;
    addStep(task, {
      type: "output",
      label: "任务完成",
      content: task.result,
    });
  }

  if (!task.result.trim() && task.outputFiles.length === 0) {
    throw new Error("任务执行结束，但没有生成任何文本结果或文件输出。");
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
      systemPrompt: buildTaskSystemPrompt(task.prompt),
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
