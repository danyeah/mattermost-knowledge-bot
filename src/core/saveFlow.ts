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
  type TopicRow,
} from "../db/repositories/topics.js";
import { createDocument, deleteDocument, getDocument, updateDocument } from "../outline/documents.js";
import { buildDocument, parseExisting, type DocumentSections, type MessageAttachment } from "./documentBuilder.js";
import type { SectionMerge } from "../ai/schemas.js";
import { buildPermalink } from "../mattermost/helpers.js";
import { mergeSections } from "../ai/sectionMerge.js";
import { processThreadAttachments } from "./attachmentHandler.js";

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
  channelDisplayName: string;
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

function pickSection(merged: string | null, prior: string | null): string | null {
  if (merged === null) return prior;
  const trimmed = merged.trim();
  return trimmed.length > 0 ? merged : prior;
}

// Apply the AI merge result onto the prior section state. Non-null, non-empty fields REPLACE;
// null or whitespace-only means "keep existing" to guard against AI returning empty strings.
function applyMerge(prior: DocumentSections, merge: SectionMerge): DocumentSections {
  return {
    summary: pickSection(merge.summary, prior.summary),
    decisions: pickSection(merge.decisions, prior.decisions),
    technical_details: pickSection(merge.technical_details, prior.technical_details),
    operational_notes: pickSection(merge.operational_notes, prior.operational_notes),
    references: pickSection(merge.references, prior.references),
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
  const { mmClient, outlineClient, logger } = ctx;

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

  // Attachment processing moved after documentId resolution
  const threadMessagesFull = thread.map((p) => {
    const attachments: MessageAttachment[] = (p.file_ids ?? []).map((fid) => {
      const mapping = attachmentMap.get(fid);
      if (!mapping) {
        return { filename: fid, outlineUrl: "", isImage: false, unavailable: true };
      }
      return {
        filename: mapping.filename,
        outlineUrl: mapping.outlineUrl,
        isImage: mapping.isImage,
      };
    });
    return {
      timestamp: new Date(p.create_at).toISOString(),
      username: threadUsernames.get(p.user_id) ?? p.user_id,
      message: p.message,
      attachments,
    };
  });

  const newEntry = {
    isoTimestamp: nowIso,
    triggeredByUsername: triggeringUsername,
    permalinkUrl: permalink,
    threadMessages: threadMessagesFull,
  };

  // AI receives text only — strip attachments.
  const threadMessages = threadMessagesFull.map(({ timestamp, username, message }) => ({
    timestamp,
    username,
    message,
  }));

  let existingTopic = findTopicByChannelAndSlug(channelId, topicSlug);
  let resolvedTopic!: TopicRow;
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
    if (merge.summary !== null && merge.summary.trim().length > 0) mergedSummaryForTopic = merge.summary;

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
      // Re-check for a race winner before inserting to avoid UNIQUE(mm_channel_id, topic_slug) violation.
      const raceWinner = findTopicByChannelAndSlug(channelId, topicSlug);
      if (raceWinner) {
        logger.warn(
          { document_id: created.id, winning_document_id: raceWinner.outline_document_id, topic_slug: topicSlug },
          "topic_slug_race_detected_deleting_orphan",
        );
        try {
          await deleteDocument(outlineClient, created.id);
        } catch (delErr) {
          logger.error({ err: delErr, document_id: created.id }, "orphan_document_delete_failed");
        }
        throw new Error("Another save raced ahead — please retry.");
      }

      db.transaction(() => {
        resolvedTopic = insertTopic({
          mm_channel_id: channelId,
          topic_slug: topicSlug,
          topic_display_name: topicDisplayName,
          outline_document_id: documentId,
          summary: mergedSummaryForTopic,
        });
        updateSaveSuccessStmt.run(resolvedTopic.id, saveId);
      })();

      logger.info(
        { document_id: documentId, channel_id: channelId, topic_slug: topicSlug },
        "outline_document_created",
      );
    } else {
      resolvedTopic = existingTopic;
      documentId = resolvedTopic.outline_document_id;

      // Process attachments with documentId so files are attached to this page
      const attachmentMap = await processThreadAttachments({
        thread,
        documentId,
        ctx: { mmClient, outlineClient, logger },
      });

      const updatedMarkdown = buildDocument({
        topicDisplayName: resolvedTopic.topic_display_name,
        lastAiUpdateIso: nowIso,
        sections: mergedSections,
        chronologicalLog: [],
        belowSeparator,
        appendEntry: newEntry,
      });

      const updated = await updateDocument(outlineClient, { id: documentId, text: updatedMarkdown });
      if (updated.urlId) documentUrlId = updated.urlId;

      db.transaction(() => {
        if (mergedSummaryForTopic !== null) {
          updateTopicSummary(resolvedTopic.id, mergedSummaryForTopic);
        } else {
          touchTopic(resolvedTopic.id);
        }
        updateSaveSuccessStmt.run(resolvedTopic.id, saveId);
      })();

      logger.info(
        { document_id: documentId, channel_id: channelId, topic_slug: topicSlug },
        "outline_document_updated",
      );
    }
  } catch (err) {
    updateSaveFailedStmt.run(err instanceof Error ? err.message : String(err), saveId);
    throw err;
  }

  const documentUrl = `${config.OUTLINE_URL}/doc/${documentUrlId ?? documentId}`;
  return {
    documentUrl,
    topicDisplayName: resolvedTopic.topic_display_name,
    channelDisplayName: channel.mm_channel_name,
    changeSummary,
  };
}
