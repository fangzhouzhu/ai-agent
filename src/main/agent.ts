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
  buildCompatibleUserContent,
  invokeOpenAICompatibleChat,
  streamOpenAICompatibleChat,
  type CompatibleMessage,
  type ImageAttachment,
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
import { isRealtimeRecommendationQuery } from "./queryRouting";
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
  attachments?: ImageAttachment[];
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

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_FALLBACK_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_REQUEST_TIMEOUT_MS = 90_000;

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
    baseUrl: OLLAMA_BASE_URL,
    streaming,
    // verbose: true, // 在主进程终端打印请求/响应详情
  });
}

function isRetryableOllamaFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("timed out") ||
    message.includes("econnrefused") ||
    message.includes("connect") ||
    message.includes("socket") ||
    message.includes("network")
  );
}

function getOllamaResourceHint(modelName: string): string {
  const totalMemoryGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  if (
    totalMemoryGb <= 20 &&
    /(7b|8b|vl|vision)/i.test(modelName)
  ) {
    return `当前机器内存约 ${totalMemoryGb} GB，运行 ${modelName} 这类视觉/7B 模型可能会长时间无响应。建议切换到更小的模型，或在更高内存环境下重试。`;
  }
  return "";
}

function toReadableOllamaError(error: unknown, modelName: string): Error {
  if (error instanceof Error) {
    const resourceHint = getOllamaResourceHint(modelName);
    if (error.name === "AbortError" || /timed out/i.test(error.message)) {
      return new Error(
        [
          `Ollama 请求超时：模型“${modelName}”在 ${Math.round(OLLAMA_REQUEST_TIMEOUT_MS / 1000)} 秒内没有返回结果。`,
          resourceHint,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    if (/fetch failed/i.test(error.message)) {
      return new Error(
        [
          `连接 Ollama 失败：无法访问 ${OLLAMA_BASE_URL}。请确认 Ollama 已启动，并检查模型“${modelName}”是否已安装。`,
          resourceHint,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    return error;
  }

  return new Error(
    `连接 Ollama 失败：请求模型“${modelName}”时发生未知错误。`,
  );
}

async function fetchOllamaApi(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const urls = [`${OLLAMA_BASE_URL}${path}`, `${OLLAMA_FALLBACK_BASE_URL}${path}`];
  let lastError: unknown = null;
  const timeoutSignal = AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS);
  const mergedSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  for (const url of urls) {
    try {
      return await fetch(url, {
        ...init,
        signal: mergedSignal,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableOllamaFetchError(error)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Ollama request failed");
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

function shouldPreCallWebSearch(userMessage: string): boolean {
  return isRealtimeRecommendationQuery(userMessage);
}

function buildRecommendationSummaryInstruction(userMessage: string): string {
  if (!shouldPreCallWebSearch(userMessage)) {
    return "请根据上面的工具结果直接回答用户问题，不要重复工具调用过程。";
  }

  return [
    "请严格基于上面的搜索结果和网页正文回答，不要凭模型记忆补充。",
    "如果证据不足，只能说“未检索到明确榜单/评测结论”或“现有证据不足以支持该结论”，不能擅自推断“尚未发布”或“官方未公布”。",
    "优先回答用户真正想要的推荐结果，不要把答案写成泛泛的市场综述。",
    "推荐类问题必须优先按维度给建议，例如：影像、性能、续航、性价比，而不是武断给出唯一“最佳”。",
    "只有在搜索结果里明确出现具体机型、发布时间、评测结论时，才能写入答案；没有证据就不要点名。",
    "最终答案请严格使用下面结构：",
    "1. 检索时间：一句话说明这是基于当前检索结果的总结。",
    "2. 直接结论：先直接回答“是否存在统一权威榜单”，如果没有，就明确说更适合按维度推荐。",
    "3. 按维度推荐：最多列 3 到 4 条，每条都包含“推荐方向/机型 + 简短依据”。",
    "4. 不确定性说明：一句话说明后续新机发布或评测更新后结论可能变化。",
    "整段回答尽量简洁，优先给出可执行建议，不要重复工具调用过程。",
  ].join("");

  if (!shouldPreCallWebSearch(userMessage)) {
    return "请根据上面的工具结果直接回答用户问题，不要重复工具调用过程。";
  }

  return [
    "请严格基于上面的搜索与网页正文结果回答，不要凭模型记忆补充。",
    "如果证据不足，只能说“未检索到明确榜单/评测结论”或“现有证据不足以支持该结论”，不能擅自推断“尚未发布”或“官方未公布”。",
    "优先按维度给建议，例如：影像、性能、续航、性价比，而不是武断给出唯一“最佳”。",
    "如果结果里出现具体机型、发布时间、评测结论，请明确说明这些信息来自搜索结果。",
    "答案开头先说明这是基于当前检索结果的总结。",
  ].join("");
}

function buildRecommendationSummaryInstructionV2(
  userMessage: string,
): string {
  if (!shouldPreCallWebSearch(userMessage)) {
    return "请根据上面的工具结果直接回答用户问题，不要重复工具调用过程。";
  }

  return [
    "请严格基于上面的搜索结果和网页正文回答，不要凭模型记忆补充。",
    "如果证据不足，只能说“未检索到明确榜单/评测结论”或“现有证据不足以支持该结论”，不能擅自推断“尚未发布”或“官方未公布”。",
    "优先回答用户真正想要的推荐结果，不要把答案写成泛泛的市场综述。",
    "推荐类问题必须优先按维度给建议，例如：影像、性能、续航、性价比，而不是武断给出唯一“最佳”。",
    "除非同一机型被至少两个独立来源同时支持，或有明确评测对比证据，否则不要点名把它写成推荐机型。",
    "官网营销文案、宣传口号、外观描述不能单独作为推荐依据。",
    "最终答案请严格使用下面结构：",
    "1. 检索时间：一句话说明这是基于当前检索结果的总结。",
    "2. 直接结论：先回答是否存在统一权威榜单；如果没有，就明确说更适合按维度推荐。",
    "3. 按维度推荐：最多列 2 到 3 条；如果证据不足，就写“暂无明确推荐机型，仅给出选购方向”。",
    "4. 不确定性说明：一句话说明后续新机发布或评测更新后结论可能变化。",
    "整段回答尽量简洁，优先给出可执行建议，不要重复工具调用过程。",
  ].join("");
}

function extractSearchResultUrls(result: string): string[] {
  const urls = result.match(/^https?:\/\/\S+$/gm) ?? [];
  const deduped = Array.from(new Set(urls.map((url) => url.trim())));
  return deduped.filter(
    (url) =>
      !/(gov\.cn|calendar|holiday|baike\.baidu|wikipedia|sports|travel|weather|zhihu\.com|zhuanlan\.zhihu\.com|xiaohongshu\.com|weibo\.com)/i.test(
        url,
      ),
  );
}

function hasUsableRecommendationEvidence(
  userMessage: string,
  preResults: PreCalledResult[],
): boolean {
  if (!shouldPreCallWebSearch(userMessage)) {
    return true;
  }

  const fetchResults = preResults.filter((result) => result.toolName === "fetch_url");
  const validFetchResults = fetchResults.filter((result) => {
    const text = result.result.trim();
    return (
      !/failed:|失败|error/i.test(text) &&
      text.length >= 300 &&
      !/无法提取|未获取到|empty/i.test(text)
    );
  });

  if (validFetchResults.length > 0) {
    return true;
  }

  if (fetchResults.length > 0) {
    return false;
  }

  const searchResults = preResults.filter(
    (result) => result.toolName === "web_search",
  );
  return searchResults.some((result) => {
    const urls = extractSearchResultUrls(result.result);
    const entryCount = (result.result.match(/^\d+\.\s+/gm) ?? []).length;
    return urls.length >= 2 && entryCount >= 2;
  });
}

type OllamaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

function toBase64Image(dataUrl: string): string | null {
  const matched = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  return matched?.[1] ?? null;
}

function toOllamaMessage(msg: ChatMessage): OllamaChatMessage {
  const images =
    msg.role === "user"
      ? (msg.attachments ?? [])
          .map((attachment) => toBase64Image(attachment.dataUrl))
          .filter((item): item is string => Boolean(item))
      : [];

  return {
    role: msg.role,
    content: msg.role === "assistant" ? stripReasoningContent(msg.content) : msg.content,
    ...(images.length > 0 ? { images } : {}),
  };
}

async function streamFromOllamaApi(
  modelName: string,
  messages: OllamaChatMessage[],
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

  let response: Response;
  try {
    response = await fetchOllamaApi("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true,
      }),
      signal,
    });
  } catch (error) {
    const readableError = toReadableOllamaError(error, modelName);
    recordTrace({
      type: "error",
      traceId,
      error: toAppError(readableError, "model", "MODEL_STREAM_FAILED"),
      at: Date.now(),
    });
    throw readableError;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail ? ` - ${detail.slice(0, 300)}` : "";
    throw new Error(`Ollama 请求失败: HTTP ${response.status}${suffix}`);
  }

  if (!response.body) {
    throw new Error("Ollama 未返回可读取的数据流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const payload = JSON.parse(trimmed) as {
          done?: boolean;
          message?: {
            content?: string;
          };
          error?: string;
        };

        if (payload.error) {
          throw new Error(payload.error);
        }

        const token = payload.message?.content ?? "";
        if (token) {
          onToken(token);
          fullResponse += token;
        }

        if (payload.done) {
          recordTrace({
            type: "model_end",
            traceId,
            model: modelName,
            durationMs: Date.now() - startedAt,
            at: Date.now(),
          });
          return fullResponse;
        }
      }
    }

    if (buffer.trim()) {
      const payload = JSON.parse(buffer.trim()) as {
        done?: boolean;
        message?: { content?: string };
        error?: string;
      };
      if (payload.error) throw new Error(payload.error);
      const token = payload.message?.content ?? "";
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

function buildWeakEvidenceRecommendationReply(): string {
  return [
    "基于这次联网结果，暂时没有提取到足够可靠的评测正文或一致结论。",
    "现在不适合直接点名“今年最好的手机”是哪一款，否则很容易误导。",
    "更稳妥的回答是：目前更适合按维度来选，比如影像、性能、续航、系统和性价比。",
    "如果你愿意，我可以继续按更具体条件帮你筛选，例如“4000元以内拍照最好的手机”或“今年续航最强的手机”。",
  ].join("");
}

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

  const compactExpression = userMessage.trim().replace(/[=?\s]/g, "");
  if (
    compactExpression &&
    /^[0-9+\-*/%^().,]+$/.test(compactExpression) &&
    /[+\-*/%^]/.test(compactExpression)
  ) {
    const args = { expression: compactExpression };
    onToolCall("calculator", args);
    try {
      const { result } = await executeTool("calculator", args, {
        signal,
        confirm: confirmTool,
      });
      onToolResult("calculator", result);
      results.push({ toolName: "calculator", args, result });
    } catch (e: any) {
      const result = `calculator 失败: ${e?.message || e}`;
      onToolResult("calculator", result);
      results.push({ toolName: "calculator", args, result });
    }
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

  if (shouldPreCallWebSearch(userMessage)) {
    const args = { query: userMessage.trim(), maxResults: 5 };
    onToolCall("web_search", args);
    try {
      const { result } = await executeTool("web_search", args, {
        signal,
        confirm: confirmTool,
      });
      onToolResult("web_search", result);
      results.push({ toolName: "web_search", args, result });

      const urls = extractSearchResultUrls(result).slice(0, 2);
      for (const url of urls) {
        const fetchArgs = { url, maxLength: 3000 };
        onToolCall("fetch_url", fetchArgs);
        try {
          const fetched = await executeTool("fetch_url", fetchArgs, {
            signal,
            confirm: confirmTool,
          });
          onToolResult("fetch_url", fetched.result);
          results.push({
            toolName: "fetch_url",
            args: fetchArgs,
            result: fetched.result,
          });
        } catch (fetchError: any) {
          const fetchResult = `fetch_url failed: ${fetchError?.message || fetchError}`;
          onToolResult("fetch_url", fetchResult);
          results.push({
            toolName: "fetch_url",
            args: fetchArgs,
            result: fetchResult,
          });
        }
      }
    } catch (e: any) {
      const result = `web_search failed: ${e?.message || e}`;
      onToolResult("web_search", result);
      results.push({ toolName: "web_search", args, result });
    }
    return results;
  }

  return results;
}

// 获取可用的 Ollama 模型列表
export async function fetchOllamaModels(): Promise<string[]> {
  try {
    const res = await fetchOllamaApi("/api/tags", {
      method: "GET",
    });
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
      msg.role === "assistant"
        ? stripReasoningContent(msg.content)
        : msg.role === "user"
          ? buildCompatibleUserContent(msg.content, msg.attachments)
          : msg.content,
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
  if (skill) return false;

  const compact = userMessage.trim().toLowerCase();
  if (!compact || compact.length > 80 || /\n/.test(compact)) return false;
  if (history.length > 2) return false;

  const explicitHeavyIntent =
    /(文件|文档|天气|联网|搜索|汇率|时间|日期|股票|报告|代码|报错|bug|debug|pdf|ppt|知识库|read file|write file|weather|search|fetch|code|debug)/i;

  if (explicitHeavyIntent.test(compact)) return false;

  return true;
}

function trimChatHistory(
  history: ChatMessage[],
  maxMessages = 6,
): ChatMessage[] {
  if (history.length <= maxMessages) return history;

  const trimmed = history.slice(-maxMessages);
  return trimmed[0]?.role === "assistant" ? trimmed.slice(1) : trimmed;
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
  attachments: ImageAttachment[] = [],
): Promise<string> {
  const route: RouteConfig = {
    provider: routeOverride?.provider ?? modelConfig.agent.provider,
    model: routeOverride?.model || modelConfig.agent.model,
  };

  if (route.provider === "ollama" && attachments.length > 0) {
    return chatStream(
      history,
      userMessage,
      onToken,
      signal,
      route.model,
      "ollama",
      skill,
      attachments,
    );
  }

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
        "calculator",
      ].includes(result.toolName),
    );

    if (shouldReturnDirectly) {
      const directText = preResults.map((result) => result.result).join("\n\n");
      onToken(directText);
      return directText;
    }
  }

  if (!hasUsableRecommendationEvidence(userMessage, preResults)) {
    const safeReply = buildWeakEvidenceRecommendationReply();
    onToken(safeReply);
    return safeReply;
  }

  if (route.provider === "openai-compatible") {
    const summaryInstruction = buildRecommendationSummaryInstructionV2(userMessage);
      const messages: CompatibleMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(skill, { enableTools: true }),
      },
      ...history.map(toCompatibleMessage),
      {
        role: "user",
        content: buildCompatibleUserContent(userMessage, attachments),
      },
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
        content: summaryInstruction,
      },
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
    const summaryInstruction = buildRecommendationSummaryInstructionV2(userMessage);
    const toolContext = preResults
      .map((r) => `[工具: ${r.toolName}]\n${r.result}`)
      .join("\n\n");
    const messagesWithContext = [
      new SystemMessage(buildSystemPrompt(skill, { enableTools: false })),
      new SystemMessage(
        `以下是已自动获取的工具结果，请基于这些结果直接回答用户问题，无需再调用工具：\n\n${toolContext}`,
      ),
      new SystemMessage(summaryInstruction),
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
  attachments: ImageAttachment[] = [],
): Promise<string> {
  if (shouldPreCallWebSearch(userMessage)) {
    return chatWithAgent(
      history,
      userMessage,
      onToken,
      () => {},
      () => {},
      signal,
      skill,
      undefined,
      undefined,
      attachments,
    );
  }

  const route: RouteConfig = {
    provider,
    model: modelName || modelConfig.chat.model,
  };
  const useLightweightPrompt = shouldUseLightweightChatPrompt(
    history,
    userMessage,
    skill,
  );
  const scopedHistory = useLightweightPrompt
    ? history.slice(-2)
    : trimChatHistory(history, 6);

  if (route.provider === "openai-compatible") {
    const systemPrompt = useLightweightPrompt
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
        ...scopedHistory.map(toCompatibleMessage),
        {
          role: "user",
          content: buildCompatibleUserContent(userMessage, attachments),
        },
      ],
      onToken,
      signal,
    });
  }

  const systemPrompt = useLightweightPrompt
    ? LIGHTWEIGHT_CHAT_SYSTEM_PROMPT
    : buildSystemPrompt(skill, { enableTools: false });

  if (attachments.length > 0) {
    const multimodalMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...scopedHistory,
      { role: "user", content: userMessage, attachments },
    ];
    return streamFromOllamaApi(
      route.model,
      multimodalMessages.map(toOllamaMessage),
      onToken,
      signal,
    );
  }

  const messages = [
    new SystemMessage(systemPrompt),
    ...scopedHistory.map(toLC),
    new HumanMessage(userMessage),
  ];

  return streamFromOllama(route.model, messages, onToken, signal);
}
