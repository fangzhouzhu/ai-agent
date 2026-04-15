import { OllamaEmbeddings } from "@langchain/ollama";
import { similaritySearch } from "./ragStore";
import { listDocuments, getKnowledgeBase } from "./ragRepository";

const embeddingsCache = new Map<string, OllamaEmbeddings>();

function getEmbeddings(model: string): OllamaEmbeddings {
  const cached = embeddingsCache.get(model);
  if (cached) return cached;
  const e = new OllamaEmbeddings({ model, baseUrl: "http://localhost:11434" });
  embeddingsCache.set(model, e);
  return e;
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
// 加入最低相关度阈值 MIN_RELEVANCE_SCORE = 0.45（混合分数 = 向量相似度 × 0.7 + 关键词命中率 × 0.3）。低于阈值的 chunks 全部过滤掉，返回空数组
// 调高后，模型获取到的上下文质量更高，但也可能导致某些查询没有任何相关内容返回（触发后续的降级策略）。可以根据实际情况调整这个阈值，以在相关性和覆盖率之间找到最佳平衡点。
const MIN_RELEVANCE_SCORE = 0.6;

export async function retrieveFromKbs(
  kbIds: string[],
  query: string,
  topK = 6,
  minScore = MIN_RELEVANCE_SCORE,
): Promise<RetrievedChunk[]> {
  const queryTokens = query
    .toLowerCase()
    .split(/[\s，。！？；：\n\t]+/)
    .filter((t) => t.length > 1);

  const wantsOverview =
    /总结|概括|概述|全文|内容|讲了什么|说了什么|主要内容|描述|介绍|分析一下|看一下|看看/i.test(
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

    const embeddings = getEmbeddings(kb.embeddingModel);
    const queryEmbedding = await embeddings.embedQuery(query);

    const fetchK = wantsOverview ? topK * 3 : topK * 2;
    const hits = await similaritySearch(kbId, queryEmbedding, fetchK);

    const kbDocs = listDocuments(kbId);

    for (const hit of hits) {
      const doc = kbDocs.find((d) => d.id === hit.documentId);
      const kw = keywordScore(hit.text, queryTokens);
      // Hybrid: 70% vector + 30% keyword
      const hybridScore = hit.score * 0.7 + kw * 0.3;

      results.push({
        kbName: kb.name,
        source: doc?.fileName ?? hit.documentId,
        content: hit.text,
        score: hybridScore,
      });
    }
  }

  // Deduplicate by content
  const unique = results.filter(
    (r, i, arr) => arr.findIndex((x) => x.content === r.content) === i,
  );

  // Sort by hybrid score
  unique.sort((a, b) => b.score - a.score);

  // Filter by minimum relevance threshold; if nothing passes, return empty → triggers fallback
  const relevant = unique.filter((r) => r.score >= minScore);

  return relevant.slice(0, topK).map((r, i) => ({
    index: i + 1,
    source: r.source,
    kbName: r.kbName,
    content: r.content,
    score: r.score,
  }));
}
