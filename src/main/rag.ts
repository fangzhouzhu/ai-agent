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

  for (const fileId of fileIds) {
    const entry = ragEntries.get(fileId);
    if (!entry) continue;

    const matches = await entry.store.similaritySearch(query, 4);
    docs.push(...matches);
  }

  return docs.slice(0, 6).map((doc, index) => ({
    index: index + 1,
    source: String(
      doc.metadata.sourceName || doc.metadata.source || "未知来源",
    ),
    content: doc.pageContent,
  }));
}
