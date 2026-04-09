import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { OllamaEmbeddings } from "@langchain/ollama";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import mammoth from "mammoth";
import pdf from "pdf-parse";

export interface RagFileMeta {
  id: string;
  name: string;
  path: string;
  chunks: number;
  uploadedAt: number;
}

type RagEntry = RagFileMeta & {
  store: MemoryVectorStore;
  docs: Array<{
    pageContent: string;
    metadata: Record<string, unknown>;
  }>;
};

const embeddings = new OllamaEmbeddings({
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434",
});

const ragEntries = new Map<string, RagEntry>();

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

function toMeta(entry: RagEntry): RagFileMeta {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    chunks: entry.chunks,
    uploadedAt: entry.uploadedAt,
  };
}

export async function ingestFile(filePath: string): Promise<RagFileMeta> {
  const existing = [...ragEntries.values()].find(
    (item) => item.path === filePath,
  );
  if (existing) {
    return toMeta(existing);
  }

  const text = await extractTextFromFile(filePath);
  if (!text) {
    throw new Error("文件内容为空，无法建立索引");
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 900,
    chunkOverlap: 150,
  });

  const docs = await splitter.createDocuments(
    [text],
    [
      {
        source: filePath,
        sourceName: basename(filePath),
      },
    ],
  );

  const store = await MemoryVectorStore.fromDocuments(docs, embeddings);
  const entry: RagEntry = {
    id: randomUUID(),
    name: basename(filePath),
    path: filePath,
    chunks: docs.length,
    uploadedAt: Date.now(),
    store,
    docs: docs.map((doc) => ({
      pageContent: doc.pageContent,
      metadata: doc.metadata as Record<string, unknown>,
    })),
  };

  ragEntries.set(entry.id, entry);
  return toMeta(entry);
}

export async function ingestFiles(filePaths: string[]): Promise<RagFileMeta[]> {
  const results: RagFileMeta[] = [];

  for (const filePath of filePaths) {
    results.push(await ingestFile(filePath));
  }

  return results;
}

export function listRagFiles(): RagFileMeta[] {
  return [...ragEntries.values()]
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
    .map(toMeta);
}

export function removeRagFile(id: string): boolean {
  return ragEntries.delete(id);
}

export async function retrieveRelevantChunks(fileIds: string[], query: string) {
  const docs = [] as Array<{
    pageContent: string;
    metadata: Record<string, unknown>;
  }>;

  const normalizedQuery = query.trim().toLowerCase();
  const wantsOverview =
    /总结|概括|概述|全文|内容|讲了什么|说了什么|主要内容|描述|介绍|分析一下|看一下|看看/i.test(
      query,
    );

  for (const fileId of fileIds) {
    const entry = ragEntries.get(fileId);
    if (!entry) continue;

    const baseName = entry.name.replace(/\.[^.]+$/, "").toLowerCase();
    const fileNameMatched =
      normalizedQuery.includes(entry.name.toLowerCase()) ||
      normalizedQuery.includes(baseName);

    const matches = await entry.store.similaritySearch(
      query,
      wantsOverview || fileIds.length === 1 ? 6 : 4,
    );
    docs.push(...matches);

    if (
      (wantsOverview || fileNameMatched || fileIds.length === 1) &&
      entry.docs.length > 0
    ) {
      docs.push(...entry.docs.slice(0, Math.min(4, entry.docs.length)));
    }
  }

  const uniqueDocs = docs.filter((doc, index, arr) => {
    const source = String(
      doc.metadata.sourceName || doc.metadata.source || "未知来源",
    );
    const key = `${source}::${doc.pageContent}`;
    return (
      arr.findIndex((item) => {
        const itemSource = String(
          item.metadata.sourceName || item.metadata.source || "未知来源",
        );
        return `${itemSource}::${item.pageContent}` === key;
      }) === index
    );
  });

  return uniqueDocs.slice(0, 6).map((doc, index) => ({
    index: index + 1,
    source: String(
      doc.metadata.sourceName || doc.metadata.source || "未知来源",
    ),
    content: doc.pageContent,
  }));
}
