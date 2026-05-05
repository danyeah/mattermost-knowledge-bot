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
  channelInfo: { id: string; name: string; team_id: string; display_name: string };
  teamName: string;
  ctx: SaveFlowCtx;
}

export async function executeSave(opts: SaveFlowOpts): Promise<{ documentUrl: string; topicDisplayName: string }> {
  const { triggeringPost, triggeringUsername, thread, threadUsernames, channelInfo, teamName, ctx } = opts;
  const { outlineClient, logger } = ctx;

  const channel = findChannelByMmId(channelInfo.id);
  if (!channel) {
    throw new Error(
      `Channel ${channelInfo.id} is not registered. The bot must be added to the channel first.`,
    );
  }

  const TOPIC_SLUG = "test-topic";
  const TOPIC_DISPLAY_NAME = "Test Topic";

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

  let existingTopic = findTopicByChannelAndSlug(channelInfo.id, TOPIC_SLUG);
  let documentId: string;
  let documentUrlId: string | undefined;

  if (!existingTopic) {
    const initialMarkdown = buildDocument({
      topicDisplayName: TOPIC_DISPLAY_NAME,
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
      title: TOPIC_DISPLAY_NAME,
      text: initialMarkdown,
    });

    documentId = created.id;
    documentUrlId = created.urlId;

    existingTopic = insertTopic({
      mm_channel_id: channelInfo.id,
      topic_slug: TOPIC_SLUG,
      topic_display_name: TOPIC_DISPLAY_NAME,
      outline_document_id: documentId,
      summary: null,
    });

    logger.info({ document_id: documentId, channel_id: channelInfo.id }, "outline_document_created");
  } else {
    documentId = existingTopic.outline_document_id;

    const existing = await getDocument(outlineClient, documentId);
    documentUrlId = existing.urlId;
    const parsed = parseExisting(existing.text);

    const updatedMarkdown = buildDocument({
      topicDisplayName: TOPIC_DISPLAY_NAME,
      lastAiUpdateIso: "never",
      sections: parsed.sections,
      chronologicalLog: [...parsed.chronologicalLog, newEntry],
    });

    const updated = await updateDocument(outlineClient, { id: documentId, text: updatedMarkdown });
    if (updated.urlId) documentUrlId = updated.urlId;

    touchTopic(existingTopic.id);
    logger.info({ document_id: documentId, channel_id: channelInfo.id }, "outline_document_updated");
  }

  const topicId = existingTopic.id;

  db.prepare(
    `INSERT INTO saves (mm_channel_id, mm_post_id, mm_root_post_id, topic_id, triggered_by_user_id, triggered_by_username, status, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, 'success', ?)`,
  ).run(
    channelInfo.id,
    triggeringPost.id,
    triggeringPost.root_id || triggeringPost.id,
    topicId,
    triggeringPost.user_id,
    triggeringUsername,
    JSON.stringify({ thread_post_count: thread.length }),
  );

  const documentUrl = `${config.OUTLINE_URL}/doc/${documentUrlId ?? documentId}`;
  return { documentUrl, topicDisplayName: TOPIC_DISPLAY_NAME };
}
