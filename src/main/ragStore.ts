import * as lancedb from "@lancedb/lancedb";
import { getRagVectorsDir } from "./storage";

export interface StoredChunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  keywords: string[];
}

// LanceDB table row shape (vector field required for ANN search)
interface LanceRow {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  text: string;
  vector: number[];
  keywords: string; // JSON-serialized string[]
}

// Singleton connection, lazily initialized
let _db: lancedb.Connection | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    _db = await lancedb.connect(getRagVectorsDir());
  }
  return _db;
}

function toRow(chunk: StoredChunk): LanceRow {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    knowledgeBaseId: chunk.knowledgeBaseId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    vector: chunk.embedding,
    keywords: JSON.stringify(chunk.keywords),
  };
}

function fromRow(row: LanceRow): StoredChunk {
  return {
    id: row.id,
    documentId: row.documentId,
    knowledgeBaseId: row.knowledgeBaseId,
    chunkIndex: row.chunkIndex,
    text: row.text,
    embedding: Array.from(row.vector),
    keywords: (() => {
      try {
        return JSON.parse(row.keywords) as string[];
      } catch {
        return [];
      }
    })(),
  };
}

export async function appendChunks(
  kbId: string,
  newChunks: StoredChunk[],
): Promise<void> {
  if (newChunks.length === 0) return;
  const db = await getDb();
  const rows = newChunks.map(toRow) as unknown as Record<string, unknown>[];
  const names = await db.tableNames();
  if (names.includes(kbId)) {
    const tbl = await db.openTable(kbId);
    await tbl.add(rows);
  } else {
    await db.createTable(kbId, rows);
  }
}

export async function removeDocumentChunks(
  kbId: string,
  documentId: string,
): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(kbId)) return;
  const tbl = await db.openTable(kbId);
  await tbl.delete(`documentId = '${documentId.replace(/'/g, "''")}'`);
}

export async function deleteKbVectors(kbId: string): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(kbId)) {
    await db.dropTable(kbId);
  }
}

export async function getKbChunkCount(kbId: string): Promise<number> {
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(kbId)) return 0;
  const tbl = await db.openTable(kbId);
  return tbl.countRows();
}

export async function similaritySearch(
  kbId: string,
  queryEmbedding: number[],
  topK = 6,
  filterDocIds?: string[],
): Promise<Array<StoredChunk & { score: number }>> {
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(kbId)) return [];

  const tbl = await db.openTable(kbId);
  const totalRows = await tbl.countRows();
  if (totalRows === 0) return [];

  let query = tbl
    .vectorSearch(queryEmbedding)
    .limit(filterDocIds ? totalRows : topK);

  if (filterDocIds && filterDocIds.length > 0) {
    const ids = filterDocIds
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(", ");
    query = query.where(`documentId IN (${ids})`);
  }

  const results = await query.toArray();

  const chunks = results.map((row) => {
    const chunk = fromRow(row as unknown as LanceRow);
    // _distance from LanceDB is L2; convert to cosine-like score (1 - normalized_distance)
    const dist: number = (row as Record<string, number>)["_distance"] ?? 0;
    const score = 1 / (1 + dist);
    return { ...chunk, score };
  });

  if (filterDocIds) {
    return chunks.slice(0, topK);
  }

  return chunks;
}
