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
    // verbose: true, // 在主进程终端打印请求/响应详情
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

type PreCalledResult = {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
};

/**
 * 关键词预路由：在发给模型之前，根据消息内容强制调用高置信度工具。
 * 用于解决小模型（3b 级别）不可靠的 tool calling 问题。
 */
async function preCallTools(
  userMessage: string,
  onToolCall: (toolName: string, input: unknown) => void,
  onToolResult: (toolName: string, result: string) => void,
  signal?: AbortSignal,
): Promise<PreCalledResult[]> {
  const results: PreCalledResult[] = [];

  // URL 检测 → fetch_url
  const urlMatch = userMessage.match(/https?:\/\/[^\s）\)。，！？]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    const fetchTool = allTools.find((t) => t.name === "fetch_url");
    if (fetchTool) {
      const args = { url };
      onToolCall("fetch_url", args);
      try {
        const result = String(await fetchTool.invoke(args, { signal }));
        onToolResult("fetch_url", result);
        results.push({ toolName: "fetch_url", args, result });
      } catch (e: any) {
        const result = `fetch_url 失败: ${e?.message || e}`;
        onToolResult("fetch_url", result);
        results.push({ toolName: "fetch_url", args, result });
      }
    }
    // URL 命中后直接返回，不再做其他预路由
    return results;
  }

  // 天气关键词 → get_weather_current
  const weatherPattern = /天气|气温|温度|下雨|下雪|阴晴|风力|weather/i;
  if (weatherPattern.test(userMessage)) {
    // 提取城市：优先匹配"XX天气/XX的天气/XX气温"，支持 1-8 个字符的地名
    const cityMatch =
      userMessage.match(
        /([^\s，,。？?！!、\n]{2,8})(?:的|地区)?(?:天气|气温|温度|下雨|下雪|阴晴|风力)/,
      ) ||
      userMessage.match(
        /(?:查|看|问|帮我查)?([^\s，,。？?！!、\n]{2,8})(?:今天|明天|现在|当前)?(?:天气|气温|温度)/,
      );
    const location = cityMatch?.[1]?.trim() || "北京";
    const weatherTool = allTools.find((t) => t.name === "get_weather_current");
    if (weatherTool) {
      const args: Record<string, unknown> = { location };
      onToolCall("get_weather_current", args);
      try {
        const result = String(await weatherTool.invoke(args, { signal }));
        onToolResult("get_weather_current", result);
        results.push({ toolName: "get_weather_current", args, result });
      } catch (e: any) {
        const result = `get_weather_current 失败: ${e?.message || e}`;
        onToolResult("get_weather_current", result);
        results.push({ toolName: "get_weather_current", args, result });
      }
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

const BASE_CHAT_SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题，并给出简洁清晰的回答。
回答尽量简洁清晰，使用 Markdown 格式；输出数学结果时请使用普通文本符号（如 ×、÷、=），不要输出 LaTeX 写法如 \times。`;

const TOOL_SYSTEM_PROMPT = `你还可以调用以下工具：
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
- generate_pdf: 根据标题和 Markdown 正文生成 PDF 报告文件
- generate_pptx: 根据标题和多张幻灯片内容生成 PowerPoint 演示文稿

当用户需要操作文件、查询时间、做数学计算、单位换算、复制文本、联网获取信息、抓取网页内容、查询天气、汇率换算时，优先使用对应的工具。
如果问题涉及今天/最新的股市、新闻、行情、汇率、金价油价等实时公开信息，必须优先调用 web_search 或 fetch_url 工具，不能仅凭训练记忆回答。
对于明确的算式或数学表达式，请优先调用 calculator 工具，不要凭心算直接猜。
【强制规则】如果用户消息中包含任何 URL 链接（以 http:// 或 https:// 开头），必须立即调用 fetch_url 工具获取内容，严禁根据训练记忆猜测或编造网页内容，违反此规则视为错误回答。
【复合任务规则】当用户要求完成一项端到端任务（如"搜索信息→分析→生成报告"），必须按步骤依次调用相关工具：先用 web_search/fetch_url 收集数据，再用 generate_pdf 或 generate_pptx 生成报告，最后告知用户文件保存路径。不得省略任何步骤。`;

function buildRuntimeContextPrompt(enableTools = false): string {
  const now = new Date();
  const display = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(now);

  return `当前系统时间参考：${display}（Asia/Shanghai），ISO：${now.toISOString()}。
如果用户询问“今天是哪天 / 今天几号 / 星期几 / 现在几点 / 当前日期”等实时问题，必须优先依据这个时间参考${enableTools ? "或调用 get_current_time 工具" : ""}回答，不能凭训练记忆猜测。`;
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
    buildRuntimeContextPrompt(enableTools),
    skillPrompt,
  ]
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
              resultStr = String(await tool.invoke(args));
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
  const preResults = await preCallTools(
    userMessage,
    onToolCall,
    onToolResult,
    signal,
  );
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
        {
          role: "system",
          content: buildSystemPrompt(skill, { enableTools: false }),
        },
        ...history.map(toCompatibleMessage),
        { role: "user", content: userMessage },
      ],
      onToken,
      signal,
    });
  }

  const messages = [
    new SystemMessage(buildSystemPrompt(skill, { enableTools: false })),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

  return streamFromOllama(route.model, messages, onToken, signal);
}
