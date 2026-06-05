import { db } from "../index.js";

export interface TopicRow {
  id: number;
  mm_channel_id: string;
  topic_slug: string;
  topic_display_name: string;
  outline_document_id: string;
  summary: string | null;
  last_indexed_at: string | null;
  created_at: string;
  last_updated_at: string;
}

const findTopicStmt = db.prepare("SELECT * FROM topics WHERE mm_channel_id = ? AND topic_slug = ?");
const listTopicsStmt = db.prepare("SELECT * FROM topics WHERE mm_channel_id = ?");
const insertTopicStmt = db.prepare(
  "INSERT INTO topics (mm_channel_id, topic_slug, topic_display_name, outline_document_id, summary) VALUES (?, ?, ?, ?, ?) RETURNING *",
);
const touchTopicStmt = db.prepare("UPDATE topics SET last_updated_at = datetime('now') WHERE id = ?");
const updateTopicSummaryStmt = db.prepare(
  "UPDATE topics SET summary = ?, last_updated_at = datetime('now') WHERE id = ?",
);
const deleteTopicByIdStmt = db.prepare("DELETE FROM topics WHERE id = ?");
const deleteChunksForDocStmt = db.prepare("DELETE FROM document_chunks WHERE doc_id = ?");
const deleteIndexStateForDocStmt = db.prepare("DELETE FROM index_state WHERE doc_id = ?");

export function findTopicByChannelAndSlug(mmChannelId: string, topicSlug: string): TopicRow | null {
  return (findTopicStmt.get(mmChannelId, topicSlug) as TopicRow | undefined) ?? null;
}

export function listTopicsByChannel(mmChannelId: string): TopicRow[] {
  return listTopicsStmt.all(mmChannelId) as TopicRow[];
}

export function insertTopic(
  row: Omit<TopicRow, "id" | "created_at" | "last_updated_at" | "last_indexed_at">,
): TopicRow {
  return insertTopicStmt.get(
    row.mm_channel_id,
    row.topic_slug,
    row.topic_display_name,
    row.outline_document_id,
    row.summary ?? null,
  ) as TopicRow;
}

export function touchTopic(topicId: number): void {
  touchTopicStmt.run(topicId);
}

export function updateTopicSummary(topicId: number, summary: string | null): void {
  const result = updateTopicSummaryStmt.run(summary, topicId);
  if (result.changes === 0) throw new Error(`updateTopicSummary: topic ${topicId} not found`);
}

/**
 * Prune a topic row whose Outline document no longer exists (deleted/archived
 * in Outline UI). Also removes any orphan embedding chunks and index state for
 * that document. saves.topic_id is set to NULL automatically by the FK.
 */
export function pruneTopicAndDocArtifacts(topicId: number, outlineDocumentId: string): void {
  const tx = db.transaction(() => {
    deleteChunksForDocStmt.run(outlineDocumentId);
    deleteIndexStateForDocStmt.run(outlineDocumentId);
    deleteTopicByIdStmt.run(topicId);
  });
  tx();
}
