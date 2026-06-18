import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import * as os from "node:os";
import * as path from "node:path";
import { listRagFiles, retrieveRelevantChunks } from "./rag";
import { allTools } from "./tools";
import { summarizeToolPolicies } from "./tools/policy";
import {
  OPENAI_COMPATIBLE_TOOLS,
  invokeOpenAICompatibleChat,
  streamOpenAICompatibleChat,
  type CompatibleMessage,
} from "./openaiCompatible";
import { buildSkillPrompt } from "./skills";
import { toAppError } from "./runtime/errors";
import {
  executeTool,
  type ToolApprovalRequest,
} from "./runtime/ToolExecutor";
import { createTraceId, recordTrace } from "./runtime/trace";
import {
  BASE_CHAT_SYSTEM_PROMPT,
  RAG_CITATION_PROMPT,
  TOOL_SYSTEM_PROMPT,
  buildRuntimeContextPrompt,
} from "./prompts/agentPrompts";
import type {
  ModelProvider,
  ModelSettings,
  OnlineProviderProfile,
  OnlineProviderSettings,
  SkillConfig,
} from "./storage";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

type RouteKey = "chat" | "agent" | "rag";

type RouteConfig = {
  provider: ModelProvider;
  model: string;
};

type ModelConfig = {
  chat: RouteConfig;
  agent: RouteConfig;
  rag: RouteConfig;
  online: Required<OnlineProviderSettings>;
  onlineProfiles: OnlineProviderProfile[];
  activeOnlineProfileId: string | null;
};

const LIGHTWEIGHT_CHAT_SYSTEM_PROMPT =
  "你是 Centibot。对于寒暄、确认、简短闲聊，直接用自然、简洁的中文回答，不要展开成长篇说明。";

function normalizeWeatherLocation(raw: string): string {
  return raw
    .trim()
    .replace(/^(查|看|问|帮我查|帮我看|请查一下|请问一下)/, "")
    .replace(/(今天|明天|后天|现在|当前|此刻|实时)+$/g, "")
    .replace(/(天气|气温|温度|下雨|下雪|阴晴|风力|怎么样|如何|多少)+$/g, "")
    .replace(/(的|地区)+$/g, "")
    .trim();
}

const DEFAULT_ONLINE_SETTINGS: Required<OnlineProviderSettings> = {
  name: "默认在线配置",
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
};

const modelConfig: ModelConfig = {
  chat: { provider: "ollama", model: "qwen2.5:3b" },
  agent: { provider: "ollama", model: "qwen2.5:3b" },
  rag: { provider: "ollama", model: "qwen2.5:3b" },
  online: { ...DEFAULT_ONLINE_SETTINGS },
  onlineProfiles: [],
  activeOnlineProfileId: null,
};

function pickPreferredModel(
  models: string[],
  matchers: RegExp[],
): string | null {
  for (const matcher of matchers) {
    const found = models.find((model) => matcher.test(model));
    if (found) return found;
  }
  return models[0] ?? null;
}

function autoConfigureModels(models: string[]): void {
  const textModels = models.filter((model) => !/embed/i.test(model));
  if (textModels.length === 0) return;

  const chatCandidate =
    pickPreferredModel(textModels, [
      /qwen.*(1\.5b|3b)|phi|mini|small|gemma.*2b/i,
      /(1\.5b|2b|3b)/i,
    ]) ?? textModels[0];

  const advancedCandidate =
    pickPreferredModel(textModels, [
      /7b|8b|14b|32b|70b|coder|instruct|deepseek|llama3|qwq/i,
      /qwen/i,
    ]) ?? chatCandidate;

  if (
    modelConfig.chat.provider === "ollama" &&
    !textModels.includes(modelConfig.chat.model)
  ) {
    modelConfig.chat.model = chatCandidate;
  }

  if (
    modelConfig.agent.provider === "ollama" &&
    !textModels.includes(modelConfig.agent.model)
  ) {
    modelConfig.agent.model = advancedCandidate;
  }

  if (
    modelConfig.rag.provider === "ollama" &&
    !textModels.includes(modelConfig.rag.model)
  ) {
    modelConfig.rag.model = advancedCandidate;
  }
}

export function applyModelSettings(settings: ModelSettings): void {
  if (settings.chatModel) modelConfig.chat.model = settings.chatModel;
  if (settings.agentModel) modelConfig.agent.model = settings.agentModel;
  if (settings.ragModel) modelConfig.rag.model = settings.ragModel;

  if (settings.chatProvider) modelConfig.chat.provider = settings.chatProvider;
  if (settings.agentProvider)
    modelConfig.agent.provider = settings.agentProvider;
  if (settings.ragProvider) modelConfig.rag.provider = settings.ragProvider;

  if (settings.online) {
    modelConfig.online = {
      ...modelConfig.online,
      ...settings.online,
    };
  }

  if (Array.isArray(settings.onlineProfiles)) {
    modelConfig.onlineProfiles = settings.onlineProfiles;
  }

  if ("activeOnlineProfileId" in settings) {
    modelConfig.activeOnlineProfileId = settings.activeOnlineProfileId ?? null;
  }
}

export function getModelSettingsSnapshot(): ModelSettings {
  return {
    chatModel: modelConfig.chat.model,
    agentModel: modelConfig.agent.model,
    ragModel: modelConfig.rag.model,
    chatProvider: modelConfig.chat.provider,
    agentProvider: modelConfig.agent.provider,
    ragProvider: modelConfig.rag.provider,
    online: { ...modelConfig.online },
    onlineProfiles: [...modelConfig.onlineProfiles],
    activeOnlineProfileId: modelConfig.activeOnlineProfileId,
  };
}

export function setChatModel(modelName: string): void {
  modelConfig.chat.model = modelName;
}

export function getChatModel(): string {
  return modelConfig.chat.model;
}

export function setAgentModel(modelName: string): void {
  modelConfig.agent.model = modelName;
}

export function getAgentModel(): string {
  return modelConfig.agent.model;
}

export function setRagModel(modelName: string): void {
  modelConfig.rag.model = modelName;
}

export function getRagModel(): string {
  return modelConfig.rag.model;
}

export function getChatProvider(): ModelProvider {
  return modelConfig.chat.provider;
}

export function getAgentProvider(): ModelProvider {
  return modelConfig.agent.provider;
}

export function getRagProvider(): ModelProvider {
  return modelConfig.rag.provider;
}

export function describeRouteModel(routeKey: RouteKey): string {
  const route = modelConfig[routeKey];
  if (route.provider === "ollama") {
    return `${route.model} · Ollama`;
  }

  const activeProfile = modelConfig.onlineProfiles.find(
    (profile) => profile.id === modelConfig.activeOnlineProfileId,
  );
  const providerLabel =
    activeProfile?.name || modelConfig.online.provider || "在线 API";

  return `${providerLabel} · ${route.model}`;
}

export function getOnlineSettings(): OnlineProviderSettings {
  return { ...modelConfig.online };
}

// 保持向后兼容：旧的单模型接口默认映射到聊天模型
export function setModel(modelName: string): void {
  setChatModel(modelName);
}

export function getModel(): string {
  return getChatModel();
}

function buildLLM(modelName: string, streaming = false): ChatOllama {
  return new ChatOllama({
    model: modelName,
    baseUrl: "http://localhost:11434",
    streaming,
    // verbose: true, // 在主进程终端打印请求/响应详情
  });
}

async function streamFromOllama(
  modelName: string,
  messages: Array<HumanMessage | AIMessage | SystemMessage>,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const traceId = createTraceId();
  const startedAt = Date.now();
  recordTrace({
    type: "model_start",
    traceId,
    model: modelName,
    messages: messages.length,
    at: startedAt,
  });
  const llm = buildLLM(modelName, true);
  let fullResponse = "";
  try {
    const stream = await llm.stream(messages, { signal });

    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const token = typeof chunk.content === "string" ? chunk.content : "";
      if (token) {
        onToken(token);
        fullResponse += token;
      }
    }

    recordTrace({
      type: "model_end",
      traceId,
      model: modelName,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    });

    return fullResponse;
  } catch (error) {
    recordTrace({
      type: "error",
      traceId,
      error: toAppError(error, "model", "MODEL_STREAM_FAILED"),
      at: Date.now(),
    });
    throw error;
  }
}

type PreCalledResult = {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
};

type SpecialFolderName =
  | "desktop"
  | "documents"
  | "downloads"
  | "pictures"
  | "music"
  | "videos";

const SPECIAL_FOLDER_MATCHERS: Array<{
  match: RegExp;
  folder: SpecialFolderName;
}> = [
  { match: /(桌面|desktop)/i, folder: "desktop" },
  { match: /(文档|我的文档|documents?)/i, folder: "documents" },
  { match: /(下载|downloads?)/i, folder: "downloads" },
  { match: /(图片|照片|pictures?|photos?)/i, folder: "pictures" },
  { match: /(音乐|music)/i, folder: "music" },
  { match: /(视频|movies?|videos?)/i, folder: "videos" },
];

function resolveSpecialFolderPath(folder: SpecialFolderName): string {
  const home = os.homedir();
  switch (folder) {
    case "desktop":
      return path.join(home, "Desktop");
    case "documents":
      return path.join(home, "Documents");
    case "downloads":
      return path.join(home, "Downloads");
    case "pictures":
      return path.join(home, "Pictures");
    case "music":
      return path.join(home, "Music");
    case "videos":
      return path.join(home, "Videos");
  }
}

function extractMentionedSpecialFolderFilePath(userMessage: string): string | null {
  const folder = SPECIAL_FOLDER_MATCHERS.find((item) => item.match.test(userMessage));
  if (!folder) return null;

  const folderMatch = userMessage.match(folder.match);
  if (!folderMatch?.index && folderMatch?.index !== 0) return null;

  const suffix = userMessage.slice(folderMatch.index + folderMatch[0].length);
  const normalizedSuffix = suffix.replace(/^[的上里中\s"'“”‘’`]+/, "");
  const fileNameMatch =
    normalizedSuffix.match(/([^“”"'`，。；;：:\s]+\.[a-zA-Z0-9_-]+)/)?.[1] ?? null;

  if (!fileNameMatch) return null;

  return path.join(resolveSpecialFolderPath(folder.folder), fileNameMatch.trim());
}

function extractRecentFileReference(
  history: ChatMessage[],
  userMessage: string,
): string | null {
  const explicitPathMatch =
    userMessage.match(/[a-zA-Z]:\\[^\r\n"<>|?*]+/g)?.at(-1) ?? null;
  if (explicitPathMatch) {
    return explicitPathMatch.trim();
  }

  const fileNameMatch =
    userMessage.match(/([^\s"“”',，。；;:]+?\.[a-zA-Z0-9_-]+)/)?.[1] ?? null;

  const reversed = [...history].reverse();
  for (const item of reversed) {
    const content = item.content || "";

    const pathMatches = content.match(/[a-zA-Z]:\\[^\r\n"<>|?*]+/g) ?? [];
    if (fileNameMatch) {
      const namedPath = [...pathMatches]
        .reverse()
        .find((candidate) =>
          candidate.toLowerCase().endsWith(`\\${fileNameMatch.toLowerCase()}`),
        );
      if (namedPath) return namedPath.trim();
    }

    if (
      /这个文件|该文件|刚才那个文件|刚刚那个文件|上一个文件/.test(userMessage) &&
      pathMatches.length > 0
    ) {
      return pathMatches[pathMatches.length - 1].trim();
    }
  }

  return null;
}

function detectLocalSystemToolCall(
  userMessage: string,
  history: ChatMessage[] = [],
): { toolName: string; args: Record<string, unknown> } | null {
  const text = userMessage.toLowerCase();

  const asksOsInfo =
    /(操作系统|系统版本|电脑系统|windows|win10|win11|macos|linux)/i.test(
      userMessage,
    ) &&
    /(是什么|哪个|哪种|版本|系统|what|which|version|os)/i.test(userMessage);

  if (asksOsInfo || /(operating system|os version)/i.test(userMessage)) {
    return {
      toolName: "get_os_info",
      args: {},
    };
  }

  const asksRunningApps =
    /(运行|开着|打开了|正在运行|进程|程序|软件|应用)/.test(userMessage) &&
    /(哪些|什么|查看|列出|帮我查|帮我看|当前|现在|电脑)/.test(userMessage);

  if (
    asksRunningApps ||
    text.includes("running apps") ||
    text.includes("running programs") ||
    text.includes("process list")
  ) {
    return {
      toolName: "list_running_apps",
      args: { limit: 20 },
    };
  }

  const folderMap: Array<{
    match: RegExp;
    folder: "desktop" | "documents" | "downloads" | "pictures" | "music" | "videos";
  }> = [
    { match: /(桌面|desktop)/i, folder: "desktop" },
    { match: /(文档|我的文档|documents?)/i, folder: "documents" },
    { match: /(下载|downloads?)/i, folder: "downloads" },
    { match: /(图片|照片|pictures?|photos?)/i, folder: "pictures" },
    { match: /(音乐|music)/i, folder: "music" },
    { match: /(视频|movies?|videos?)/i, folder: "videos" },
  ];
  const resolveSpecialFolderPath = (
    folder: "desktop" | "documents" | "downloads" | "pictures" | "music" | "videos",
  ): string => {
    const home = os.homedir();
    switch (folder) {
      case "desktop":
        return path.join(home, "Desktop");
      case "documents":
        return path.join(home, "Documents");
      case "downloads":
        return path.join(home, "Downloads");
      case "pictures":
        return path.join(home, "Pictures");
      case "music":
        return path.join(home, "Music");
      case "videos":
        return path.join(home, "Videos");
    }
  };

  const createIntent =
    /(创建|新建|生成|写入|保存)/.test(userMessage) &&
    /(文件|文档|txt|md|json|csv|js|ts|html|css)/i.test(userMessage);

  if (createIntent) {
    for (const item of folderMap) {
      if (!item.match.test(userMessage)) continue;

      const fileNameMatch =
        userMessage.match(
          /(?:创建|新建|生成|写入|保存)(?:一个|一份|个)?\s*["“]?([^"”',，。；;:\s]+\.[a-zA-Z0-9_-]+)["”]?/i,
        ) ||
        userMessage.match(
          /["“]([^"”]+?\.[a-zA-Z0-9_-]+)["”]/i,
        );

      if (!fileNameMatch?.[1]) continue;

      const fileName = fileNameMatch[1].trim();
      const contentMatch =
        userMessage.match(
          /(?:内容(?:是|为)?|写入|里面写|内容写成|内容[:：]|content\s*(?:is|=|:))\s*([\s\S]+)/i,
        ) || userMessage.match(/[,，]\s*([\s\S]+)$/);
      const rawContent = contentMatch?.[1]?.trim() ?? "";
      const content = rawContent.replace(/^["“]|["”]$/g, "");

      return {
        toolName: "write_file",
        args: {
          filePath: path.join(resolveSpecialFolderPath(item.folder), fileName),
          content,
        },
      };
    }
  }

  const deleteIntent =
    /(删除|删掉|移除|去掉|清理|扔掉)/.test(userMessage) &&
    /(文件|文档|txt|md|json|csv|js|ts|html|css|这个|那个)/i.test(userMessage);

  if (deleteIntent) {
    const filePath =
      extractMentionedSpecialFolderFilePath(userMessage) ??
      extractRecentFileReference(history, userMessage);
    if (filePath) {
      return {
        toolName: "delete_file",
        args: { filePath },
      };
    }
  }

  const readIntent =
    /(读取|打开|查看|看看|显示|告诉我|读一下)/.test(userMessage) &&
    /(文件|文档|txt|md|json|csv|js|ts|html|css|这个|那个)/i.test(userMessage);

  if (readIntent) {
    const filePath = extractRecentFileReference(history, userMessage);
    if (filePath) {
      return {
        toolName: "read_file",
        args: { filePath },
      };
    }
  }

  const asksFolderContents =
    /(文件|文件夹|内容|东西|有哪些|有什么|列出|看看|查看|帮我查|帮我看)/.test(
      userMessage,
    ) || text.includes("list");

  for (const item of folderMap) {
    if (item.match.test(userMessage) && asksFolderContents) {
      return {
        toolName: "list_special_folder",
        args: {
          folder: item.folder,
          limit: 50,
          includeHidden: false,
        },
      };
    }
  }

  return null;
}

/**
 * 关键词预路由：在发给模型之前，根据消息内容强制调用高置信度工具。
 * 用于解决小模型（3b 级别）不可靠的 tool calling 问题。
 */
async function preCallTools(
  history: ChatMessage[],
  userMessage: string,
  onToolCall: (toolName: string, input: unknown) => void,
  onToolResult: (toolName: string, result: string) => void,
  confirmTool?: (request: ToolApprovalRequest) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<PreCalledResult[]> {
  const results: PreCalledResult[] = [];

  const localSystemTool = detectLocalSystemToolCall(userMessage, history);
  if (localSystemTool) {
    onToolCall(localSystemTool.toolName, localSystemTool.args);
    try {
      const { result } = await executeTool(
        localSystemTool.toolName,
        localSystemTool.args,
        { signal, confirm: confirmTool },
      );
      onToolResult(localSystemTool.toolName, result);
      results.push({
        toolName: localSystemTool.toolName,
        args: localSystemTool.args,
        result,
      });
    } catch (e: any) {
      const result = `${localSystemTool.toolName} failed: ${e?.message || e}`;
      onToolResult(localSystemTool.toolName, result);
      results.push({
        toolName: localSystemTool.toolName,
        args: localSystemTool.args,
        result,
      });
    }
    return results;
  }

  // URL 检测 → fetch_url
  const urlMatch = userMessage.match(/https?:\/\/[^\s）\)。，！？]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    const args = { url };
    onToolCall("fetch_url", args);
    try {
      const { result } = await executeTool("fetch_url", args, { signal, confirm: confirmTool });
      onToolResult("fetch_url", result);
      results.push({ toolName: "fetch_url", args, result });
    } catch (e: any) {
      const result = `fetch_url 失败: ${e?.message || e}`;
      onToolResult("fetch_url", result);
      results.push({ toolName: "fetch_url", args, result });
    }
    // URL 命中后直接返回，不再做其他预路由
    return results;
  }

  // 天气关键词 → get_weather_current
  const weatherPattern = /天气|气温|温度|下雨|下雪|阴晴|风力|weather/i;
  if (weatherPattern.test(userMessage)) {
    // 尽量只提取地点本身，避免把“今天/现在/怎么样”带进 location。
    const weatherLocationPatterns = [
      /([^\s，,。？?！!、\n]{2,12}?)(?:的|地区)?(?:今天|明天|后天|现在|当前)?(?:天气|气温|温度|下雨|下雪|阴晴|风力)/,
      /(?:查|看|问|帮我查|帮我看|请查一下|请问一下)?([^\s，,。？?！!、\n]{2,12}?)(?:今天|明天|后天|现在|当前)?(?:天气|气温|温度)/,
    ];
    const rawLocation =
      weatherLocationPatterns
        .map((pattern) => userMessage.match(pattern)?.[1])
        .find(Boolean) || "北京";
    const location = normalizeWeatherLocation(rawLocation) || "北京";
    const args: Record<string, unknown> = { location };
    onToolCall("get_weather_current", args);
    try {
      const { result } = await executeTool("get_weather_current", args, {
        signal,
        confirm: confirmTool,
      });
      onToolResult("get_weather_current", result);
      results.push({ toolName: "get_weather_current", args, result });
    } catch (e: any) {
      const result = `get_weather_current 失败: ${e?.message || e}`;
      onToolResult("get_weather_current", result);
      results.push({ toolName: "get_weather_current", args, result });
    }
  }

  return results;
}

// 获取可用的 Ollama 模型列表
export async function fetchOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return [];
    const data = (await res.json()) as { models: { name: string }[] };
    const models = data.models.map((m) => m.name);
    autoConfigureModels(models);
    return models;
  } catch {
    return [];
  }
}

function stripReasoningContent(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, " ")
    .trim();
}

function toLC(msg: ChatMessage) {
  const content =
    msg.role === "assistant" ? stripReasoningContent(msg.content) : msg.content;
  if (msg.role === "user") return new HumanMessage(content);
  if (msg.role === "assistant") return new AIMessage(content);
  return new SystemMessage(content);
}

function toCompatibleMessage(msg: ChatMessage): CompatibleMessage {
  return {
    role: msg.role,
    content:
      msg.role === "assistant" ? stripReasoningContent(msg.content) : msg.content,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildSystemPrompt(
  skill?: SkillConfig | null,
  options?: { enableTools?: boolean },
): string {
  const skillPrompt = buildSkillPrompt(skill);
  const enableTools = Boolean(options?.enableTools);

  return [
    BASE_CHAT_SYSTEM_PROMPT,
    enableTools ? TOOL_SYSTEM_PROMPT : "",
    enableTools ? `工具安全策略：\n${summarizeToolPolicies()}` : "",
    buildRuntimeContextPrompt(enableTools),
    skillPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function shouldUseLightweightChatPrompt(
  history: ChatMessage[],
  userMessage: string,
  skill?: SkillConfig | null,
): boolean {
  if (history.length > 0 || skill) return false;

  const compact = userMessage.trim().toLowerCase();
  if (!compact || compact.length > 24) return false;

  return /^(你好|您好|嗨|hi|hello|在吗|早上好|下午好|晚上好|谢谢|好的|ok|嗯|哈喽)$/.test(
    compact,
  );
}

// 带工具的流式聊天（Agent 模式）
export async function chatWithAgent(
  history: ChatMessage[],
  userMessage: string,
  onToken: (token: string) => void,
  onToolCall: (toolName: string, input: unknown) => void,
  onToolResult: (toolName: string, result: string) => void,
  signal?: AbortSignal,
  skill?: SkillConfig | null,
  confirmTool?: (request: ToolApprovalRequest) => Promise<boolean>,
  routeOverride?: Partial<RouteConfig>,
): Promise<string> {
  const route: RouteConfig = {
    provider: routeOverride?.provider ?? modelConfig.agent.provider,
    model: routeOverride?.model || modelConfig.agent.model,
  };
  const preResults = await preCallTools(
    history,
    userMessage,
    onToolCall,
    onToolResult,
    confirmTool,
    signal,
  );

  if (preResults.length > 0) {
    const shouldReturnDirectly = preResults.every((result) =>
      [
        "get_os_info",
        "list_running_apps",
        "list_special_folder",
        "write_file",
        "delete_file",
        "read_file",
      ].includes(result.toolName),
    );

    if (shouldReturnDirectly) {
      const directText = preResults.map((result) => result.result).join("\n\n");
      onToken(directText);
      return directText;
    }
  }

  if (route.provider === "openai-compatible") {
    const messages: CompatibleMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(skill, { enableTools: true }),
      },
      ...history.map(toCompatibleMessage),
      { role: "user", content: userMessage },
    ];

    // 最多执行 8 轮工具调用，避免无限循环
    for (let i = 0; i < 8; i++) {
      signal?.throwIfAborted();
      const response = await invokeOpenAICompatibleChat({
        settings: modelConfig.online,
        model: route.model,
        messages,
        tools: OPENAI_COMPATIBLE_TOOLS,
        signal,
      });

      if (response.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          signal?.throwIfAborted();
          const tool = allTools.find(
            (item) => item.name === toolCall.function.name,
          );

          const args = parseToolArguments(toolCall.function.arguments);
          onToolCall(toolCall.function.name, args);

          let resultStr: string;
          if (!tool) {
            resultStr = `工具 ${toolCall.function.name} 不存在`;
          } else {
            try {
              resultStr = (
                await executeTool(toolCall.function.name, args, {
                  signal,
                  confirm: confirmTool,
                })
              ).result;
            } catch (e: any) {
              resultStr = `工具执行失败: ${e?.message || e}`;
            }
          }

          onToolResult(toolCall.function.name, resultStr);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultStr,
          });
        }

        continue;
      }

      // 模型返回了最终内容（不再调用工具）
      const finalContent = response.content?.trim();
      if (finalContent) {
        onToken(finalContent);
        return finalContent;
      }

      // content 为空但也没有 tool_calls，说明模型输出耗尽或被截断
      // 此时用不带 tool 历史的简化消息再请求一次，让模型输出总结
      break;
    }

    // 工具轮次结束后，过滤掉 tool/assistant-with-tool 消息，仅保留核心结果摘要请求
    const summaryMessages: CompatibleMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(skill, { enableTools: false }),
      },
      { role: "user", content: userMessage },
      {
        role: "user",
        content:
          "请根据上面的工具搜索结果，给出一个清晰的中文总结回答，不要重复工具调用内容。",
      },
      // 把 tool 结果摘要注入进来
      ...messages
        .filter((m) => m.role === "tool")
        .map((m, idx) => ({
          role: "user" as const,
          content: `工具结果 ${idx + 1}：${(m.content || "").slice(0, 1200)}`,
        })),
    ];

    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: summaryMessages,
      onToken,
      signal,
    });
  }

  // 关键词预路由：强制调用高置信度工具，不依赖小模型自己决定是否调用
  if (preResults.length > 0) {
    const toolContext = preResults
      .map((r) => `[工具: ${r.toolName}]\n${r.result}`)
      .join("\n\n");
    const messagesWithContext = [
      new SystemMessage(buildSystemPrompt(skill, { enableTools: false })),
      new SystemMessage(
        `以下是已自动获取的工具结果，请基于这些结果直接回答用户问题，无需再调用工具：\n\n${toolContext}`,
      ),
      ...history.map(toLC),
      new HumanMessage(userMessage),
    ];
    return streamFromOllama(route.model, messagesWithContext, onToken, signal);
  }

  const llm = buildLLM(route.model, false);
  const llmWithTools = llm.bindTools(allTools);
  const messages = [
    new SystemMessage(buildSystemPrompt(skill, { enableTools: true })),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();

    const response = await llmWithTools.invoke(messages, { signal });

    if (response.tool_calls && response.tool_calls.length > 0) {
      messages.push(response);

      for (const toolCall of response.tool_calls) {
        signal?.throwIfAborted();
        const tool = allTools.find((t) => t.name === toolCall.name);
        if (!tool) continue;

        onToolCall(toolCall.name, toolCall.args);
        const resultStr = (
          await executeTool(toolCall.name, toolCall.args, {
            signal,
            confirm: confirmTool,
          })
        ).result;
        onToolResult(toolCall.name, resultStr);

        messages.push({
          role: "tool" as const,
          content: resultStr,
          tool_call_id: toolCall.id ?? "",
        } as any);
      }
    } else {
      break;
    }
  }

  return streamFromOllama(route.model, messages, onToken, signal);
}

// 基于已上传文档的 RAG 流式问答
export async function chatWithRag(
  history: ChatMessage[],
  userMessage: string,
  fileIds: string[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
  skill?: SkillConfig | null,
): Promise<string> {
  const route = modelConfig.rag;
  const chunks = await retrieveRelevantChunks(fileIds, userMessage);
  const activeFileNames = listRagFiles()
    .filter((file) => fileIds.includes(file.id))
    .map((file) => file.name);

  const contextText = chunks.length
    ? chunks
        .map(
          (chunk) =>
            `[${chunk.index}] Source: ${chunk.source}\n${chunk.content}`,
        )
        .join("\n\n")
    : "未检索到可用文档片段。";

  const scopedHistory = history.filter((msg) => msg.role === "user").slice(-4);
  const fileScopeText = activeFileNames.length
    ? activeFileNames.join("、")
    : "当前没有激活的文档";

  const skillPrompt = buildSkillPrompt(skill);
  const ragPrompt = `你是一个文档分析助手。当前有效文档仅限：${fileScopeText}。
请优先依据“检索上下文”回答问题，并尽量给出简洁结论。
如果用户之前聊过其他文件、旧版本文件或已移除的文件，你必须忽略那些历史内容，不能沿用旧文件信息。
如果当前只有一个已上传文件，而用户问“这个文件讲了什么 / 具体内容是什么 / 帮我总结一下”，应将其理解为对该文件整体内容的概括请求。
只要已经检索到片段，就要先基于片段进行总结、概括或引用；只有在完全没有检索到片段时，才明确说明“在当前已上传文件中未找到明确依据”，不要轻易直接拒答。${skillPrompt ? `\n\n${skillPrompt}` : ""}`;
  if (route.provider === "openai-compatible") {
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: [
        { role: "system", content: ragPrompt },
        { role: "system", content: RAG_CITATION_PROMPT },
        { role: "system", content: `检索上下文：\n${contextText}` },
        ...scopedHistory.map(toCompatibleMessage),
        { role: "user", content: userMessage },
      ],
      onToken,
      signal,
    });
  }

  const messages = [
    new SystemMessage(ragPrompt),
    new SystemMessage(RAG_CITATION_PROMPT),
    new SystemMessage(`检索上下文：\n${contextText}`),
    ...scopedHistory.map(toLC),
    new HumanMessage(userMessage),
  ];

  return streamFromOllama(route.model, messages, onToken, signal);
}

// 普通流式聊天（无工具）
export async function chatStream(
  history: ChatMessage[],
  userMessage: string,
  onToken: (token: string) => void,
  signal?: AbortSignal,
  modelName = modelConfig.chat.model,
  provider: ModelProvider = modelConfig.chat.provider,
  skill?: SkillConfig | null,
): Promise<string> {
  const route: RouteConfig = {
    provider,
    model: modelName || modelConfig.chat.model,
  };

  if (route.provider === "openai-compatible") {
    const systemPrompt = shouldUseLightweightChatPrompt(
      history,
      userMessage,
      skill,
    )
      ? LIGHTWEIGHT_CHAT_SYSTEM_PROMPT
      : buildSystemPrompt(skill, { enableTools: false });
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...history.map(toCompatibleMessage),
        { role: "user", content: userMessage },
      ],
      onToken,
      signal,
    });
  }

  const systemPrompt = shouldUseLightweightChatPrompt(history, userMessage, skill)
    ? LIGHTWEIGHT_CHAT_SYSTEM_PROMPT
    : buildSystemPrompt(skill, { enableTools: false });
  const messages = [
    new SystemMessage(systemPrompt),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

  return streamFromOllama(route.model, messages, onToken, signal);
}
