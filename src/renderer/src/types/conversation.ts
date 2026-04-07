import { v4 as uuidv4 } from "uuid";

export interface MessageModelInfo {
  model: string;
  scene: string;
  skill?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  modelInfo?: MessageModelInfo;
  ragContextId?: string;
  isStreaming?: boolean;
  isError?: boolean;
}

export interface ConvMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// 完整的对话（元数据 + 消息），仅在内存中使用
export interface Conversation extends ConvMeta {
  messages: Message[];
  /** 消息是否已从磁盘加载 */
  loaded: boolean;
}

export function createConversation(): Conversation {
  return {
    id: uuidv4(),
    title: "新对话",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    loaded: true,
  };
}

export function createMessage(
  role: "user" | "assistant",
  content: string,
): Message {
  return {
    id: uuidv4(),
    role,
    content,
  };
}

// 根据第一条用户消息生成会话标题
export function generateTitle(firstMessage: string): string {
  const maxLen = 24;
  const clean = firstMessage.trim().replace(/\n/g, " ");
  return clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
}

// 将内存中的 Message 转为可存储的格式（去掉 isStreaming）
export function toStoredMessage(m: Message) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    toolResults: m.toolResults,
    modelInfo: m.modelInfo,
    ragContextId: m.ragContextId,
    isError: m.isError,
  };
}
