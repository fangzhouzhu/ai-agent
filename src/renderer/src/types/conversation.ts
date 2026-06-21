import { v4 as uuidv4 } from "uuid";
import type { ImageAttachment, Task } from "../../../preload/index";

export interface MessageModelInfo {
  model: string;
  scene: string;
  skill?: string;
  routeMs?: number;
  diagnostics?: {
    routeMs?: number;
    firstToolCallMs?: number;
    toolCount?: number;
    toolTotalMs?: number;
    lastToolFinishedMs?: number;
    finalAnswerStartMs?: number;
    firstTokenMs?: number;
    totalMs?: number;
  };
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ImageAttachment[];
  task?: Task;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  modelInfo?: MessageModelInfo;
  ragContextId?: string;
  durationMs?: number;
  firstTokenMs?: number;
  isStreaming?: boolean;
  isError?: boolean;
  isStopped?: boolean;
}

export interface ConvMeta {
  id: string;
  title: string;
  agentProfileId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation extends ConvMeta {
  messages: Message[];
  loaded: boolean;
}

export function createConversation(
  agentProfileId: string | null,
): Conversation {
  return {
    id: uuidv4(),
    title: "新对话",
    agentProfileId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    loaded: true,
  };
}

export function createMessage(
  role: "user" | "assistant",
  content: string,
  attachments?: ImageAttachment[],
): Message {
  return {
    id: uuidv4(),
    role,
    content,
    attachments,
  };
}

export function generateTitle(firstMessage: string): string {
  const maxLen = 24;
  const clean = firstMessage.trim().replace(/\n/g, " ");
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

export function toStoredMessage(m: Message) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    attachments: m.attachments,
    task: m.task,
    toolCalls: m.toolCalls,
    toolResults: m.toolResults,
    modelInfo: m.modelInfo,
    ragContextId: m.ragContextId,
    durationMs: m.durationMs,
    firstTokenMs: m.firstTokenMs,
    isError: m.isError,
    isStopped: m.isStopped,
  };
}
