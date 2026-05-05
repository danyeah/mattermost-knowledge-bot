import type { Post } from "../mattermost/client.js";
import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { findChannelByMmId } from "../db/repositories/channels.js";
import { findTopicByChannelAndSlug, insertTopic, touchTopic } from "../db/repositories/topics.js";
import { createDocument, getDocument, updateDocument } from "../outline/documents.js";
import { buildDocument, parseExisting } from "./documentBuilder.js";
import { buildPermalink } from "../mattermost/helpers.js";

interface SaveFlowCtx {
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
}

interface SaveFlowOpts {
  triggeringPost: Post;
  triggeringUsername: string;
  thread: Post[];
  threadUsernames: Map<string, string>;
  channelId: string;
  teamName: string;
  topicSlug: string;
  topicDisplayName: string;
  ctx: SaveFlowCtx;
}

const insertSaveStmt = db.prepare(
  `INSERT INTO saves (mm_channel_id, mm_post_id, mm_root_post_id, triggered_by_user_id, triggered_by_username, status, error_message, payload_json)
   VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?)`,
);

const updateSaveSuccessStmt = db.prepare(
  `UPDATE saves SET status = 'success', error_message = NULL WHERE id = ?`,
);

const updateSaveFailedStmt = db.prepare(
  `UPDATE saves SET error_message = ? WHERE id = ?`,
);

export async function executeSave(opts: SaveFlowOpts): Promise<{ documentUrl: string; topicDisplayName: string }> {
  const {
    triggeringPost,
    triggeringUsername,
    thread,
    threadUsernames,
    channelId,
    teamName,
    topicSlug,
    topicDisplayName,
    ctx,
  } = opts;
  const { outlineClient, logger } = ctx;

  const channel = findChannelByMmId(channelId);
  if (!channel) {
    throw new Error(
      `Channel ${channelId} is not registered. The bot must be added to the channel first.`,
    );
  }

  // Insert the saves row early as 'failed' so that on any subsequent failure the idempotency guard
  // (mm_post_id UNIQUE) prevents duplicate Outline writes on retry, and the row captures the error.
  const saveRow = insertSaveStmt.run(
    channelId,
    triggeringPost.id,
    triggeringPost.root_id || triggeringPost.id,
    triggeringPost.user_id,
    triggeringUsername,
    JSON.stringify({ thread_post_count: thread.length, topic_slug: topicSlug }),
  );
  const saveId = saveRow.lastInsertRowid;

  const permalink = buildPermalink(config.MM_URL, teamName, triggeringPost.root_id || triggeringPost.id);
  const nowIso = new Date().toISOString();

  const threadMessages = thread.map((p) => ({
    timestamp: new Date(p.create_at).toISOString(),
    username: threadUsernames.get(p.user_id) ?? p.user_id,
    message: p.message,
  }));

  const newEntry = {
    isoTimestamp: nowIso,
    triggeredByUsername: triggeringUsername,
    permalinkUrl: permalink,
    threadMessages,
  };

  let existingTopic = findTopicByChannelAndSlug(channelId, topicSlug);
  let documentId: string;
  let documentUrlId: string | undefined;

  try {
    if (!existingTopic) {
      const initialMarkdown = buildDocument({
        topicDisplayName,
        lastAiUpdateIso: "never",
        sections: {
          summary: null,
          decisions: null,
          technical_details: null,
          operational_notes: null,
          references: null,
        },
        chronologicalLog: [newEntry],
      });

      const created = await createDocument(outlineClient, {
        collectionId: channel.outline_collection_id,
        title: topicDisplayName,
        text: initialMarkdown,
      });

      documentId = created.id;
      documentUrlId = created.urlId;

      existingTopic = insertTopic({
        mm_channel_id: channelId,
        topic_slug: topicSlug,
        topic_display_name: topicDisplayName,
        outline_document_id: documentId,
        summary: null,
      });

      logger.info({ document_id: documentId, channel_id: channelId, topic_slug: topicSlug }, "outline_document_created");
    } else {
      documentId = existingTopic.outline_document_id;

      const existing = await getDocument(outlineClient, documentId);
      documentUrlId = existing.urlId;
      const parsed = parseExisting(existing.text);

      const updatedMarkdown = buildDocument({
        topicDisplayName: existingTopic.topic_display_name,
        lastAiUpdateIso: "never",
        sections: parsed.sections,
        chronologicalLog: [],
        belowSeparator: parsed.belowSeparator,
        appendEntry: newEntry,
      });

      const updated = await updateDocument(outlineClient, { id: documentId, text: updatedMarkdown });
      if (updated.urlId) documentUrlId = updated.urlId;

      touchTopic(existingTopic.id);
      logger.info({ document_id: documentId, channel_id: channelId, topic_slug: topicSlug }, "outline_document_updated");
    }
  } catch (err) {
    updateSaveFailedStmt.run(err instanceof Error ? err.message : String(err), saveId);
    throw err;
  }

  updateSaveSuccessStmt.run(saveId);

  const documentUrl = `${config.OUTLINE_URL}/doc/${documentUrlId ?? documentId}`;
  return { documentUrl, topicDisplayName: existingTopic.topic_display_name };
}
