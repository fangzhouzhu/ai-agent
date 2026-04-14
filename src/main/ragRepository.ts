import { randomUUID } from "node:crypto";
import { join } from "path";
import * as fs from "fs";
import { getRagDir } from "./storage";

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  docCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KbDocument {
  id: string;
  knowledgeBaseId: string;
  fileName: string;
  originalPath: string;
  storedPath: string;
  hash: string;
  size: number;
  status: "pending" | "parsing" | "chunking" | "embedding" | "ready" | "failed";
  chunkCount: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

function getKbFile(): string {
  return join(getRagDir(), "knowledge-bases.json");
}

function getDocFile(): string {
  return join(getRagDir(), "documents.json");
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---- Knowledge Base CRUD ----

export function listKnowledgeBases(): KnowledgeBase[] {
  return readJSON<KnowledgeBase[]>(getKbFile(), []).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function getKnowledgeBase(id: string): KnowledgeBase | null {
  return listKnowledgeBases().find((kb) => kb.id === id) ?? null;
}

export function createKnowledgeBase(data: {
  name: string;
  description?: string;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}): KnowledgeBase {
  const kbs = readJSON<KnowledgeBase[]>(getKbFile(), []);
  const kb: KnowledgeBase = {
    id: randomUUID(),
    name: data.name,
    description: data.description ?? "",
    embeddingModel: data.embeddingModel ?? "nomic-embed-text",
    chunkSize: data.chunkSize ?? 900,
    chunkOverlap: data.chunkOverlap ?? 150,
    docCount: 0,
    chunkCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  kbs.unshift(kb);
  writeJSON(getKbFile(), kbs);
  return kb;
}

export function updateKnowledgeBase(
  id: string,
  data: Partial<Omit<KnowledgeBase, "id" | "createdAt">>,
): KnowledgeBase | null {
  const kbs = readJSON<KnowledgeBase[]>(getKbFile(), []);
  const idx = kbs.findIndex((k) => k.id === id);
  if (idx < 0) return null;
  kbs[idx] = { ...kbs[idx], ...data, updatedAt: Date.now() };
  writeJSON(getKbFile(), kbs);
  return kbs[idx];
}

export function deleteKnowledgeBase(id: string): boolean {
  const kbs = readJSON<KnowledgeBase[]>(getKbFile(), []);
  const filtered = kbs.filter((k) => k.id !== id);
  if (filtered.length === kbs.length) return false;
  writeJSON(getKbFile(), filtered);
  // also remove orphan documents from index
  const docs = readJSON<KbDocument[]>(getDocFile(), []);
  writeJSON(
    getDocFile(),
    docs.filter((d) => d.knowledgeBaseId !== id),
  );
  return true;
}

// ---- Document CRUD ----

export function listDocuments(kbId?: string): KbDocument[] {
  const docs = readJSON<KbDocument[]>(getDocFile(), []);
  return kbId ? docs.filter((d) => d.knowledgeBaseId === kbId) : docs;
}

export function getDocument(id: string): KbDocument | null {
  return listDocuments().find((d) => d.id === id) ?? null;
}

export function addDocument(doc: KbDocument): void {
  const docs = readJSON<KbDocument[]>(getDocFile(), []);
  docs.push(doc);
  writeJSON(getDocFile(), docs);
}

export function updateDocument(
  id: string,
  data: Partial<Omit<KbDocument, "id">>,
): KbDocument | null {
  const docs = readJSON<KbDocument[]>(getDocFile(), []);
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  docs[idx] = { ...docs[idx], ...data, updatedAt: Date.now() };
  writeJSON(getDocFile(), docs);
  return docs[idx];
}

export function removeDocument(id: string): KbDocument | null {
  const docs = readJSON<KbDocument[]>(getDocFile(), []);
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const [removed] = docs.splice(idx, 1);
  writeJSON(getDocFile(), docs);
  return removed;
}

export function recalcKbStats(kbId: string): void {
  const allDocs = listDocuments(kbId);
  const readyDocs = allDocs.filter((d) => d.status === "ready");
  const chunkCount = readyDocs.reduce((s, d) => s + d.chunkCount, 0);
  updateKnowledgeBase(kbId, {
    docCount: allDocs.length,
    chunkCount,
  });
}
