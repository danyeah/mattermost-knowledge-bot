import { db } from "../index.js";

export interface PendingConfirmationRow {
  id: number;
  mm_channel_id: string;
  mm_thread_root_id: string;
  mm_trigger_post_id: string;
  bot_reply_post_id: string;
  triggered_by_user_id: string;
  proposed_topic_slug: string;
  proposed_topic_name: string;
  alternative_topics: string;
  payload_json: string;
  expires_at: string;
  created_at: string;
}

const insertPendingStmt = db.prepare(
  `INSERT INTO pending_confirmations (
     mm_channel_id, mm_thread_root_id, mm_trigger_post_id, bot_reply_post_id,
     triggered_by_user_id, proposed_topic_slug, proposed_topic_name,
     alternative_topics, payload_json, expires_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
);

const findByBotReplyStmt = db.prepare(
  "SELECT * FROM pending_confirmations WHERE bot_reply_post_id = ?",
);

const findActiveByThreadStmt = db.prepare(
  `SELECT * FROM pending_confirmations
   WHERE mm_thread_root_id = ? AND expires_at > ?
   ORDER BY id DESC LIMIT 1`,
);

const deleteByIdStmt = db.prepare("DELETE FROM pending_confirmations WHERE id = ?");

const deleteExpiredStmt = db.prepare(
  "DELETE FROM pending_confirmations WHERE expires_at <= ?",
);

export function insertPendingConfirmation(
  row: Omit<PendingConfirmationRow, "id" | "created_at">,
): PendingConfirmationRow {
  return insertPendingStmt.get(
    row.mm_channel_id,
    row.mm_thread_root_id,
    row.mm_trigger_post_id,
    row.bot_reply_post_id,
    row.triggered_by_user_id,
    row.proposed_topic_slug,
    row.proposed_topic_name,
    row.alternative_topics,
    row.payload_json,
    row.expires_at,
  ) as PendingConfirmationRow;
}

export function findPendingByBotReplyId(postId: string): PendingConfirmationRow | null {
  return (findByBotReplyStmt.get(postId) as PendingConfirmationRow | undefined) ?? null;
}

export function findActivePendingByThreadRoot(threadRootId: string): PendingConfirmationRow | null {
  return (
    (findActiveByThreadStmt.get(threadRootId, new Date().toISOString()) as PendingConfirmationRow | undefined) ?? null
  );
}

export function deletePendingById(id: number): void {
  deleteByIdStmt.run(id);
}

export function deleteExpiredPending(nowIso: string): number {
  const info = deleteExpiredStmt.run(nowIso);
  return info.changes;
}
