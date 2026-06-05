-- RAG: chunked document embeddings for semantic search
CREATE TABLE IF NOT EXISTS document_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id      TEXT    NOT NULL,            -- Outline document ID
  doc_title   TEXT    NOT NULL,
  doc_url     TEXT    NOT NULL,
  chunk_index INTEGER NOT NULL,
  heading     TEXT    NOT NULL,            -- Section heading
  content     TEXT    NOT NULL,            -- Raw chunk text
  embedding   TEXT    NOT NULL,            -- JSON-encoded float array
  indexed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id);

-- Tracks per-document indexing state to support incremental sync
CREATE TABLE IF NOT EXISTS index_state (
  doc_id       TEXT PRIMARY KEY,
  doc_revision INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
