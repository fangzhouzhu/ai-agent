import { randomUUID, createHash } from "node:crypto";
import { readFile, copyFile } from "node:fs/promises";
import { basename, extname, join } from "path";
import * as fs from "fs";
import { OllamaEmbeddings } from "@langchain/ollama";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import { BrowserWindow } from "electron";
import {
  type KbDocument,
  addDocument,
  updateDocument,
  removeDocument,
  listDocuments,
  recalcKbStats,
  getKnowledgeBase,
} from "./ragRepository";
import { appendChunks, removeDocumentChunks } from "./ragStore";
import { getRagFilesDir } from "./storage";

const embeddingsCache = new Map<string, OllamaEmbeddings>();

function getEmbeddings(model: string): OllamaEmbeddings {
  const cached = embeddingsCache.get(model);
  if (cached) return cached;
  const e = new OllamaEmbeddings({ model, baseUrl: "http://localhost:11434" });
  embeddingsCache.set(model, e);
  return e;
}

function sendProgress(data: {
  docId: string;
  kbId: string;
  status: string;
  message: string;
  progress?: number;
}): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send("kb:indexing-progress", data);
    }
  });
}

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const buffer = await readFile(filePath);
    const result = await pdf(buffer);
    return normalizeText(result.text || "");
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return normalizeText(result.value || "");
  }
  const content = await readFile(filePath, "utf-8");
  return normalizeText(content);
}

async function hashFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "的",
    "了",
    "和",
    "是",
    "在",
    "有",
    "为",
    "与",
    "到",
    "以",
    "对",
    "from",
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "in",
    "to",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "that",
    "this",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(
          /[\s，。！？；：""''（）[\]{}<>/\\|+\-=~`@#$%^&*,.!?;:"'()\n\t]+/,
        )
        .filter((w) => w.length > 1 && !stopWords.has(w))
        .slice(0, 20),
    ),
  ];
}

export async function ingestDocumentToKb(
  kbId: string,
  filePath: string,
): Promise<KbDocument> {
  const kb = getKnowledgeBase(kbId);
  if (!kb) throw new Error(`知识库不存在: ${kbId}`);

  const hash = await hashFile(filePath);

  // Dedup: same hash in same KB
  const existing = listDocuments(kbId).find((d) => d.hash === hash);
  if (existing) return existing;

  const fileName = basename(filePath);
  const filesDir = getRagFilesDir();
  const storedName = `${randomUUID()}-${fileName}`;
  const storedPath = join(filesDir, storedName);

  await copyFile(filePath, storedPath);

  const stat = fs.statSync(filePath);
  const docId = randomUUID();
  const now = Date.now();

  const doc: KbDocument = {
    id: docId,
    knowledgeBaseId: kbId,
    fileName,
    originalPath: filePath,
    storedPath,
    hash,
    size: stat.size,
    status: "pending",
    chunkCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  addDocument(doc);
  recalcKbStats(kbId);

  // Async indexing — errors are caught and persisted to document status
  indexDocumentAsync(
    doc,
    kb.embeddingModel,
    kb.chunkSize,
    kb.chunkOverlap,
  ).catch((err) => {
    console.error("Indexing error:", err);
    updateDocument(docId, { status: "failed", errorMessage: String(err) });
    recalcKbStats(kbId);
    sendProgress({ docId, kbId, status: "failed", message: String(err) });
  });

  return doc;
}

async function indexDocumentAsync(
  doc: KbDocument,
  embeddingModel: string,
  chunkSize: number,
  chunkOverlap: number,
): Promise<void> {
  const { id: docId, knowledgeBaseId: kbId } = doc;

  // 1. Parse
  sendProgress({
    docId,
    kbId,
    status: "parsing",
    message: `正在解析 ${doc.fileName}...`,
  });
  updateDocument(docId, { status: "parsing" });

  const text = await extractTextFromFile(doc.storedPath);
  if (!text) throw new Error("文件内容为空，无法建立索引");

  // 2. Chunk
  sendProgress({
    docId,
    kbId,
    status: "chunking",
    message: `正在切片 ${doc.fileName}...`,
  });
  updateDocument(docId, { status: "chunking" });

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
  const docs = await splitter.createDocuments(
    [text],
    [{ source: doc.originalPath, sourceName: doc.fileName, docId, kbId }],
  );

  // 3. Embed in batches
  sendProgress({
    docId,
    kbId,
    status: "embedding",
    message: `正在向量化 ${doc.fileName}（共 ${docs.length} 片）...`,
    progress: 0,
  });
  updateDocument(docId, { status: "embedding" });

  const embeddings = getEmbeddings(embeddingModel);
  const batchSize = 10;
  const storedChunks = [];

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const texts = batch.map((c) => c.pageContent);
    const vectors = await embeddings.embedDocuments(texts);

    for (let j = 0; j < batch.length; j++) {
      storedChunks.push({
        id: randomUUID(),
        documentId: docId,
        knowledgeBaseId: kbId,
        chunkIndex: i + j,
        text: batch[j].pageContent,
        embedding: vectors[j],
        keywords: extractKeywords(batch[j].pageContent),
      });
    }

    const progress = Math.round(((i + batch.length) / docs.length) * 100);
    sendProgress({
      docId,
      kbId,
      status: "embedding",
      message: `向量化中... ${progress}%`,
      progress,
    });
  }

  // 4. Persist
  await appendChunks(kbId, storedChunks);
  updateDocument(docId, { status: "ready", chunkCount: storedChunks.length });
  recalcKbStats(kbId);

  sendProgress({
    docId,
    kbId,
    status: "ready",
    message: `${doc.fileName} 已完成索引`,
    progress: 100,
  });
}

export async function removeDocumentFromKb(docId: string): Promise<void> {
  const doc = listDocuments().find((d) => d.id === docId);
  if (!doc) return;

  await removeDocumentChunks(doc.knowledgeBaseId, docId);

  if (fs.existsSync(doc.storedPath)) {
    fs.unlinkSync(doc.storedPath);
  }

  removeDocument(docId);
  recalcKbStats(doc.knowledgeBaseId);
}

export async function rebuildDocumentIndex(docId: string): Promise<void> {
  const doc = listDocuments().find((d) => d.id === docId);
  if (!doc) throw new Error(`文档不存在: ${docId}`);

  const kb = getKnowledgeBase(doc.knowledgeBaseId);
  if (!kb) throw new Error(`知识库不存在: ${doc.knowledgeBaseId}`);

  await removeDocumentChunks(doc.knowledgeBaseId, docId);
  updateDocument(docId, {
    status: "pending",
    chunkCount: 0,
    errorMessage: undefined,
  });

  await indexDocumentAsync(
    doc,
    kb.embeddingModel,
    kb.chunkSize,
    kb.chunkOverlap,
  );
}
