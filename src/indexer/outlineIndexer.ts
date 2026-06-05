import type { OutlineClient } from "../outline/client.js";
import { listAllDocuments } from "../outline/documents.js";
import { chunkDocument } from "./chunker.js";
import { embed } from "../embedding/client.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";

const getStateStmt = db.prepare<[string], { doc_revision: number }>(
  "SELECT doc_revision FROM index_state WHERE doc_id = ?"
);
const upsertStateStmt = db.prepare(
  "INSERT INTO index_state (doc_id, doc_revision) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET doc_revision = excluded.doc_revision, indexed_at = datetime('now')"
);
const deleteChunksStmt = db.prepare("DELETE FROM document_chunks WHERE doc_id = ?");
const insertChunkStmt = db.prepare(
  "INSERT INTO document_chunks (doc_id, doc_title, doc_url, collection_id, chunk_index, heading, content, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);

const EMBED_BATCH = 8;

export async function indexDocument(
  client: OutlineClient,
  docId: string,
  docTitle: string,
  docText: string,
  docRevision: number,
  docUrl: string,
  collectionId = ""
): Promise<void> {
  const state = getStateStmt.get(docId);
  if (state && state.doc_revision === docRevision) return; // already up to date

  const chunks = chunkDocument(docText, docTitle);
  if (chunks.length === 0) {
    upsertStateStmt.run(docId, docRevision);
    return;
  }

  // Embed in batches
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => `${c.heading}\n${c.content}`);
    const vecs = await embed(batch);
    embeddings.push(...vecs);
  }

  const tx = db.transaction(() => {
    deleteChunksStmt.run(docId);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      insertChunkStmt.run(
        docId,
        docTitle,
        docUrl,
        collectionId,
        c.chunkIndex,
        c.heading,
        c.content,
        JSON.stringify(embeddings[i] ?? [])
      );
    }
    upsertStateStmt.run(docId, docRevision);
  });
  tx();

  logger.info({ docId, docTitle, chunks: chunks.length }, "document_indexed");
}

export async function runFullSync(client: OutlineClient): Promise<void> {
  logger.info("outline_index_sync_start");
  let indexed = 0;
  let skipped = 0;

  for await (const doc of listAllDocuments(client)) {
    try {
      const before = indexed;
      await indexDocument(client, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "", doc.collectionId ?? "");
      if (indexed === before) skipped++; else indexed++;
    } catch (err) {
      logger.warn({ err, docId: doc.id, docTitle: doc.title }, "index_doc_failed");
    }
  }

  logger.info({ indexed, skipped }, "outline_index_sync_done");
}
