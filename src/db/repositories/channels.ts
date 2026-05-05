import { db } from "../index.js";

export interface ChannelRow {
  mm_channel_id: string;
  mm_channel_name: string;
  outline_collection_id: string;
  created_at: string;
  created_by_user_id: string;
}

const findChannelStmt = db.prepare("SELECT * FROM channels WHERE mm_channel_id = ?");
const insertChannelStmt = db.prepare(
  "INSERT INTO channels (mm_channel_id, mm_channel_name, outline_collection_id, created_by_user_id) VALUES (?, ?, ?, ?)",
);

export function findChannelByMmId(mmChannelId: string): ChannelRow | null {
  return (findChannelStmt.get(mmChannelId) as ChannelRow | undefined) ?? null;
}

export function insertChannel(row: Omit<ChannelRow, "created_at">): void {
  insertChannelStmt.run(row.mm_channel_id, row.mm_channel_name, row.outline_collection_id, row.created_by_user_id);
}
