import { db } from "../db/index.js";
import { embedOne } from "../embedding/client.js";

export interface RetrievedChunk {
  docId: string;
  docTitle: string;
  docUrl: string;
  heading: string;
  content: string;
  score: number;
}

interface ChunkRow {
  doc_id: string;
  doc_title: string;
  doc_url: string;
  heading: string;
  content: string;
  embedding: string;
}

// Global retrieval — every chunk in the vector store.
const allChunksStmt = db.prepare<[], ChunkRow>(
  "SELECT doc_id, doc_title, doc_url, heading, content, embedding FROM document_chunks",
);

// Per-channel retrieval — joins through topics so we only see chunks for docs
// the bot created in this Mattermost channel. Documents created directly in
// Outline UI (no matching topic row) are excluded.
const chunksByChannelStmt = db.prepare<[string], ChunkRow>(`
  SELECT dc.doc_id, dc.doc_title, dc.doc_url, dc.heading, dc.content, dc.embedding
  FROM document_chunks dc
  JOIN topics t ON t.outline_document_id = dc.doc_id
  WHERE t.mm_channel_id = ?
`);

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) * (a[i] ?? 0);
    magB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function search(
  query: string,
  topK = 5,
  channelId?: string,
): Promise<RetrievedChunk[]> {
  const queryVec = await embedOne(query);
  const rows = channelId
    ? chunksByChannelStmt.all(channelId)
    : allChunksStmt.all();

  const scored = rows.map((row) => ({
    docId: row.doc_id,
    docTitle: row.doc_title,
    docUrl: row.doc_url,
    heading: row.heading,
    content: row.content,
    score: cosine(queryVec, JSON.parse(row.embedding) as number[]),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
