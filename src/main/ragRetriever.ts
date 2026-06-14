import { OllamaEmbeddings } from "@langchain/ollama";
import { similaritySearch } from "./ragStore";
import { listDocuments, getKnowledgeBase } from "./ragRepository";

const embeddingsCache = new Map<string, OllamaEmbeddings>();

function getEmbeddings(model: string): OllamaEmbeddings {
  const cached = embeddingsCache.get(model);
  if (cached) return cached;
  const instance = new OllamaEmbeddings({
    model,
    baseUrl: "http://localhost:11434",
  });
  embeddingsCache.set(model, instance);
  return instance;
}

function buildQueryTokens(query: string): string[] {
  const baseTokens = query
    .toLowerCase()
    .split(/[\s，。！？；：\n\t]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  const tokens = new Set<string>(baseTokens);

  for (const token of baseTokens) {
    const normalized = token.replace(/[^\p{Script=Han}a-z0-9]/gu, "");
    if (normalized.length <= 1) continue;

    if (/[\p{Script=Han}]/u.test(normalized)) {
      for (let size = 2; size <= 3; size++) {
        if (normalized.length < size) continue;
        for (let index = 0; index <= normalized.length - size; index++) {
          tokens.add(normalized.slice(index, index + size));
        }
      }
    }
  }

  return [...tokens];
}

function keywordScore(text: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) hits++;
  }
  return hits / queryTokens.length;
}

export interface RetrievedChunk {
  index: number;
  source: string;
  kbName: string;
  content: string;
  score: number;
}

const MIN_RELEVANCE_SCORE = 0.6;

export async function retrieveFromKbs(
  kbIds: string[],
  query: string,
  topK = 6,
  minScore = MIN_RELEVANCE_SCORE,
): Promise<RetrievedChunk[]> {
  const queryTokens = buildQueryTokens(query);
  const wantsOverview =
    /总结|概括|概述|全文|内容|讲了什么|说了什么|主要内容|描述|介绍|分析一下|看一看|看看/i.test(
      query,
    );

  const results: Array<{
    source: string;
    kbName: string;
    content: string;
    score: number;
  }> = [];

  for (const kbId of kbIds) {
    const kb = getKnowledgeBase(kbId);
    if (!kb) continue;

    const kbDocs = listDocuments(kbId);
    const readyDocIds = kbDocs
      .filter((doc) => doc.status === "ready")
      .map((doc) => doc.id);
    if (readyDocIds.length === 0) continue;

    const embeddings = getEmbeddings(kb.embeddingModel);
    const queryEmbedding = await embeddings.embedQuery(query);
    const fetchK = wantsOverview ? topK * 3 : topK * 2;
    const hits = await similaritySearch(kbId, queryEmbedding, fetchK, readyDocIds);

    for (const hit of hits) {
      const doc = kbDocs.find((item) => item.id === hit.documentId);
      const kw = keywordScore(hit.text, queryTokens);
      const hybridScore = hit.score * 0.7 + kw * 0.3;

      results.push({
        kbName: kb.name,
        source: doc?.fileName ?? hit.documentId,
        content: hit.text,
        score: hybridScore,
      });
    }
  }

  const unique = results.filter(
    (result, index, arr) =>
      arr.findIndex((item) => item.content === result.content) === index,
  );

  unique.sort((a, b) => b.score - a.score);
  const relevant = unique.filter((item) => item.score >= minScore);

  return relevant.slice(0, topK).map((item, index) => ({
    index: index + 1,
    source: item.source,
    kbName: item.kbName,
    content: item.content,
    score: item.score,
  }));
}
