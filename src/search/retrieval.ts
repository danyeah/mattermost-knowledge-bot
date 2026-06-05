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
  collection_id: string;
  heading: string;
  content: string;
  embedding: string;
}

export interface SearchScope {
  channelId?: string;
  docPath?: string;       // Outline doc path, e.g. /doc/title-abc123
  collectionId?: string;  // Outline collection UUID
}

// Global retrieval — every chunk in the vector store.
const allChunksStmt = db.prepare<[], ChunkRow>(
  "SELECT doc_id, doc_title, doc_url, collection_id, heading, content, embedding FROM document_chunks",
);

// Per-channel retrieval — joins through topics so we only see chunks for docs
// the bot created in this Mattermost channel.
const chunksByChannelStmt = db.prepare<[string], ChunkRow>(`
  SELECT dc.doc_id, dc.doc_title, dc.doc_url, dc.collection_id, dc.heading, dc.content, dc.embedding
  FROM document_chunks dc
  JOIN topics t ON t.outline_document_id = dc.doc_id
  WHERE t.mm_channel_id = ?
`);

// Outline page-context retrieval
const chunksByDocPathStmt = db.prepare<[string], ChunkRow>(
  "SELECT doc_id, doc_title, doc_url, collection_id, heading, content, embedding FROM document_chunks WHERE doc_url LIKE '%' || ?",
);
const chunksByCollectionStmt = db.prepare<[string], ChunkRow>(
  "SELECT doc_id, doc_title, doc_url, collection_id, heading, content, embedding FROM document_chunks WHERE collection_id = ?",
);

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
  scope?: SearchScope,
): Promise<RetrievedChunk[]> {
  const queryVec = await embedOne(query);

  let rows: ChunkRow[];
  if (scope?.channelId) {
    rows = chunksByChannelStmt.all(scope.channelId);
  } else if (scope?.docPath) {
    rows = chunksByDocPathStmt.all(scope.docPath);
  } else if (scope?.collectionId) {
    rows = chunksByCollectionStmt.all(scope.collectionId);
  } else {
    rows = allChunksStmt.all();
  }

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
