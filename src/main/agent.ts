import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { listRagFiles, retrieveRelevantChunks } from "./rag";
import { allTools } from "./tools";
import {
  OPENAI_COMPATIBLE_TOOLS,
  invokeOpenAICompatibleChat,
  streamOpenAICompatibleChat,
  type CompatibleMessage,
} from "./openaiCompatible";
import { buildSkillPrompt } from "./skills";
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
  });
}

async function streamFromOllama(
  modelName: string,
  messages: Array<HumanMessage | AIMessage | SystemMessage>,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const llm = buildLLM(modelName, true);
  let fullResponse = "";
  const stream = await llm.stream(messages, { signal });

  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const token = typeof chunk.content === "string" ? chunk.content : "";
    if (token) {
      onToken(token);
      fullResponse += token;
    }
  }

  return fullResponse;
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

function toLC(msg: ChatMessage) {
  if (msg.role === "user") return new HumanMessage(msg.content);
  if (msg.role === "assistant") return new AIMessage(msg.content);
  return new SystemMessage(msg.content);
}

function toCompatibleMessage(msg: ChatMessage): CompatibleMessage {
  return {
    role: msg.role,
    content: msg.content,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const BASE_SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题、联网查询信息，以及操作本地文件系统。
你拥有以下工具：
- read_file: 读取文件内容
- write_file: 写入文件
- list_directory: 列出目录内容
- delete_file: 删除文件
- search_files: 按文件名搜索文件
- get_current_time: 获取当前日期和时间
- calculator: 计算数学表达式
- unit_convert: 进行单位换算
- clipboard_copy: 复制文本到系统剪贴板
- web_search: 联网搜索公开网页信息
- fetch_url: 抓取网页标题和正文摘要
- get_weather_current: 查询当前天气
- currency_convert: 进行汇率换算

当用户需要操作文件、查询时间、做数学计算、单位换算、复制文本、联网获取信息、抓取网页内容、查询天气、汇率换算时，优先使用对应的工具。
对于明确的算式或数学表达式，请优先调用 calculator 工具，不要凭心算直接猜。
回答尽量简洁清晰，使用 Markdown 格式；输出数学结果时请使用普通文本符号（如 ×、÷、=），不要输出 LaTeX 写法如 \times。`;

function buildRuntimeContextPrompt(): string {
  const now = new Date();
  const display = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(now);

  return `当前系统时间参考：${display}（Asia/Shanghai），ISO：${now.toISOString()}。
如果用户询问“今天是哪天 / 今天几号 / 星期几 / 现在几点 / 当前日期”等实时问题，必须优先依据这个时间参考或调用 get_current_time 工具回答，不能凭训练记忆猜测。`;
}

function buildSystemPrompt(skill?: SkillConfig | null): string {
  const skillPrompt = buildSkillPrompt(skill);
  return [BASE_SYSTEM_PROMPT, buildRuntimeContextPrompt(), skillPrompt]
    .filter(Boolean)
    .join("\n\n");
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
): Promise<string> {
  const route = modelConfig.agent;

  if (route.provider === "openai-compatible") {
    const messages: CompatibleMessage[] = [
      { role: "system", content: buildSystemPrompt(skill) },
      ...history.map(toCompatibleMessage),
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < 5; i++) {
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
          if (!tool) continue;

          const args = parseToolArguments(toolCall.function.arguments);
          onToolCall(toolCall.function.name, args);
          const result = await tool.invoke(args);
          const resultStr = String(result);
          onToolResult(toolCall.function.name, resultStr);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultStr,
          });
        }

        continue;
      }

      if (response.content) {
        onToken(response.content);
        return response.content;
      }
    }

    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages,
      onToken,
      signal,
    });
  }

  const llm = buildLLM(route.model, false);
  const llmWithTools = llm.bindTools(allTools);
  const messages = [
    new SystemMessage(buildSystemPrompt(skill)),
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
        const result = await tool.invoke(toolCall.args);
        const resultStr = String(result);
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
            `【片段 ${chunk.index}｜${chunk.source}】\n${chunk.content}`,
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
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: [
        { role: "system", content: buildSystemPrompt(skill) },
        ...history.map(toCompatibleMessage),
        { role: "user", content: userMessage },
      ],
      onToken,
      signal,
    });
  }

  const messages = [
    new SystemMessage(buildSystemPrompt(skill)),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

  return streamFromOllama(route.model, messages, onToken, signal);
}
