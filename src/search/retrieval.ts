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

const allChunksStmt = db.prepare<[], {
  doc_id: string;
  doc_title: string;
  doc_url: string;
  heading: string;
  content: string;
  embedding: string;
}>("SELECT doc_id, doc_title, doc_url, heading, content, embedding FROM document_chunks");

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

export async function search(query: string, topK = 5): Promise<RetrievedChunk[]> {
  const queryVec = await embedOne(query);
  const rows = allChunksStmt.all();

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
