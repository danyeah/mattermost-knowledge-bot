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

export function findTopicByChannelAndSlug(mmChannelId: string, topicSlug: string): TopicRow | null {
  const row = db
    .prepare("SELECT * FROM topics WHERE mm_channel_id = ? AND topic_slug = ?")
    .get(mmChannelId, topicSlug) as TopicRow | undefined;
  return row ?? null;
}

export function listTopicsByChannel(mmChannelId: string): TopicRow[] {
  return db.prepare("SELECT * FROM topics WHERE mm_channel_id = ?").all(mmChannelId) as TopicRow[];
}

export function insertTopic(
  row: Omit<TopicRow, "id" | "created_at" | "last_updated_at" | "last_indexed_at">,
): TopicRow {
  const result = db
    .prepare(
      "INSERT INTO topics (mm_channel_id, topic_slug, topic_display_name, outline_document_id, summary) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      row.mm_channel_id,
      row.topic_slug,
      row.topic_display_name,
      row.outline_document_id,
      row.summary ?? null,
    ) as TopicRow;
  return result;
}

export function touchTopic(topicId: number): void {
  db.prepare("UPDATE topics SET last_updated_at = datetime('now') WHERE id = ?").run(topicId);
}
