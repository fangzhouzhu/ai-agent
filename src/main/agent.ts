import { ChatOllama } from "@langchain/ollama";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { allTools } from "./tools";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

let currentModel = "qwen2.5:3b";

export function setModel(modelName: string): void {
  currentModel = modelName;
}

export function getModel(): string {
  return currentModel;
}

function buildLLM(streaming = false): ChatOllama {
  return new ChatOllama({
    model: currentModel,
    baseUrl: "http://localhost:11434",
    streaming,
    // verbose: true, // 在主进程终端打印请求/响应详情
  });
}

function extractResponseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

// 获取可用的 Ollama 模型列表
export async function fetchOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return [];
    const data = (await res.json()) as { models: { name: string }[] };
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}

// 将历史消息转换为 LangChain 格式
function toLC(msg: ChatMessage) {
  if (msg.role === "user") return new HumanMessage(msg.content);
  if (msg.role === "assistant") return new AIMessage(msg.content);
  return new SystemMessage(msg.content);
}

const SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题、联网查询信息，以及操作本地文件系统。
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
回答尽量简洁清晰，使用 Markdown 格式。`;

// 带工具的流式聊天（Agent 模式）
export async function chatWithAgent(
  history: ChatMessage[],
  userMessage: string,
  onToken: (token: string) => void,
  onToolCall: (toolName: string, input: unknown) => void,
  onToolResult: (toolName: string, result: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const llm = buildLLM(false);
  const llmWithTools = llm.bindTools(allTools);
  const streamingLLM = buildLLM(true);

  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

  let fullResponse = "";
  let hasToolCalls = false;

  // 最多 5 轮工具调用
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();

    const response = await llmWithTools.invoke(messages, { signal });

    if (response.tool_calls && response.tool_calls.length > 0) {
      hasToolCalls = true;
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
      // 无工具调用，使用流式输出
      break;
    }
  }

  // 流式输出最终结果
  const stream = await streamingLLM.stream(messages, { signal });
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

// 普通流式聊天（无工具）
export async function chatStream(
  history: ChatMessage[],
  userMessage: string,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const llm = buildLLM(true);

  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new HumanMessage(userMessage),
  ];

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
