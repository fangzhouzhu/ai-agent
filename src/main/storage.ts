import { app } from "electron";
import { join } from "path";
import * as fs from "fs";

// 存储根目录：%APPDATA%\ai-agent\  (Windows)
// ~/Library/Application Support/ai-agent/  (macOS)
function getDataDir(): string {
  const dir = join(app.getPath("userData"), "ai-agent");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConvDir(): string {
  const dir = join(getDataDir(), "conversations");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const INDEX_FILE = () => join(getDataDir(), "index.json");
const ACTIVE_FILE = () => join(getDataDir(), "active.json");

export interface ConvMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  isError?: boolean;
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---- 索引操作 ----

export function listConversations(): ConvMeta[] {
  return readJSON<ConvMeta[]>(INDEX_FILE(), []).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

function saveIndex(metas: ConvMeta[]): void {
  writeJSON(INDEX_FILE(), metas);
}

// ---- 单条对话操作 ----

export function loadConversation(id: string): StoredMessage[] {
  const file = join(getConvDir(), `${id}.json`);
  return readJSON<StoredMessage[]>(file, []);
}

export function saveConversation(
  meta: ConvMeta,
  messages: StoredMessage[],
): void {
  // 更新索引
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
  } else {
    metas.unshift(meta);
  }
  saveIndex(metas);

  // 写消息文件
  const file = join(getConvDir(), `${meta.id}.json`);
  writeJSON(file, messages);
}

export function deleteConversation(id: string): void {
  // 从索引删除
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  saveIndex(metas.filter((m) => m.id !== id));

  // 删除消息文件
  const file = join(getConvDir(), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function updateConversationMeta(meta: ConvMeta): void {
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
    saveIndex(metas);
  }
}

// ---- 活跃 ID ----

export function getActiveId(): string | null {
  return readJSON<{ id: string | null }>(ACTIVE_FILE(), { id: null }).id;
}

export function setActiveId(id: string | null): void {
  writeJSON(ACTIVE_FILE(), { id });
}
