import type { Post } from "../mattermost/client.js";
import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { findChannelByMmId } from "../db/repositories/channels.js";
import {
  findTopicByChannelAndSlug,
  insertTopic,
  touchTopic,
  updateTopicSummary,
} from "../db/repositories/topics.js";
import { createDocument, getDocument, updateDocument } from "../outline/documents.js";
import { buildDocument, parseExisting, type DocumentSections } from "./documentBuilder.js";
import { buildPermalink } from "../mattermost/helpers.js";
import { mergeSections } from "../ai/sectionMerge.js";

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

export interface SaveFlowResult {
  documentUrl: string;
  topicDisplayName: string;
  collectionName: string;
  changeSummary: string;
}

const insertSaveStmt = db.prepare(
  `INSERT INTO saves (mm_channel_id, mm_post_id, mm_root_post_id, triggered_by_user_id, triggered_by_username, status, error_message, payload_json)
   VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?)`,
);

const updateSaveSuccessStmt = db.prepare(
  `UPDATE saves SET status = 'success', error_message = NULL, topic_id = ? WHERE id = ?`,
);

const updateSaveFailedStmt = db.prepare(
  `UPDATE saves SET error_message = ? WHERE id = ?`,
);

const EMPTY_SECTIONS: DocumentSections = {
  summary: null,
  decisions: null,
  technical_details: null,
  operational_notes: null,
  references: null,
};

// Apply the AI merge result onto the prior section state. Non-null fields REPLACE,
// null fields KEEP. This is the single source of truth for the merge semantics.
function applyMerge(
  prior: DocumentSections,
  merge: { summary: string | null; decisions: string | null; technical_details: string | null; operational_notes: string | null; references: string | null },
): DocumentSections {
  return {
    summary: merge.summary !== null ? merge.summary : prior.summary,
    decisions: merge.decisions !== null ? merge.decisions : prior.decisions,
    technical_details: merge.technical_details !== null ? merge.technical_details : prior.technical_details,
    operational_notes: merge.operational_notes !== null ? merge.operational_notes : prior.operational_notes,
    references: merge.references !== null ? merge.references : prior.references,
  };
}

export async function executeSave(opts: SaveFlowOpts): Promise<SaveFlowResult> {
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

  // Insert early as 'failed': the UNIQUE(mm_post_id) guard prevents duplicate Outline writes on retry.
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
  const todayIso = nowIso.slice(0, 10);

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
  let changeSummary: string;
  let mergedSummaryForTopic: string | null = null;

  try {
    let priorSections: DocumentSections;
    let belowSeparator: string;

    if (existingTopic) {
      const existing = await getDocument(outlineClient, existingTopic.outline_document_id);
      documentUrlId = existing.urlId;
      const parsed = parseExisting(existing.text);
      priorSections = parsed.sections;
      belowSeparator = parsed.belowSeparator;
    } else {
      priorSections = EMPTY_SECTIONS;
      belowSeparator = "";
    }

    // The chronological log is intentionally NOT passed to the AI — only curated sections + new thread.
    const merge = await mergeSections({
      todayIso,
      topicDisplayName: existingTopic?.topic_display_name ?? topicDisplayName,
      existingSections: priorSections,
      threadMessages,
    });
    changeSummary = merge.change_summary;
    if (merge.summary !== null) mergedSummaryForTopic = merge.summary;

    const mergedSections = applyMerge(priorSections, merge);

    if (!existingTopic) {
      const initialMarkdown = buildDocument({
        topicDisplayName,
        lastAiUpdateIso: nowIso,
        sections: mergedSections,
        chronologicalLog: [newEntry],
      });

      const created = await createDocument(outlineClient, {
        collectionId: channel.outline_collection_id,
        title: topicDisplayName,
        text: initialMarkdown,
      });

      documentId = created.id;
      documentUrlId = created.urlId;

      // Insert the topic only after the Outline document exists, so the row never points to a missing doc.
      existingTopic = insertTopic({
        mm_channel_id: channelId,
        topic_slug: topicSlug,
        topic_display_name: topicDisplayName,
        outline_document_id: documentId,
        summary: mergedSummaryForTopic,
      });

      logger.info(
        { document_id: documentId, channel_id: channelId, topic_slug: topicSlug },
        "outline_document_created",
      );
    } else {
      documentId = existingTopic.outline_document_id;

      const updatedMarkdown = buildDocument({
        topicDisplayName: existingTopic.topic_display_name,
        lastAiUpdateIso: nowIso,
        sections: mergedSections,
        chronologicalLog: [],
        belowSeparator,
        appendEntry: newEntry,
      });

      const updated = await updateDocument(outlineClient, { id: documentId, text: updatedMarkdown });
      if (updated.urlId) documentUrlId = updated.urlId;

      if (mergedSummaryForTopic !== null) {
        updateTopicSummary(existingTopic.id, mergedSummaryForTopic);
      } else {
        touchTopic(existingTopic.id);
      }

      logger.info(
        { document_id: documentId, channel_id: channelId, topic_slug: topicSlug },
        "outline_document_updated",
      );
    }
  } catch (err) {
    updateSaveFailedStmt.run(err instanceof Error ? err.message : String(err), saveId);
    throw err;
  }

  updateSaveSuccessStmt.run(existingTopic.id, saveId);

  const documentUrl = `${config.OUTLINE_URL}/doc/${documentUrlId ?? documentId}`;
  return {
    documentUrl,
    topicDisplayName: existingTopic.topic_display_name,
    collectionName: channel.mm_channel_name,
    changeSummary,
  };
}
