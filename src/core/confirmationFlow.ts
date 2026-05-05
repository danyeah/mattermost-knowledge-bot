import type { Post, MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import type { TopicDetection } from "../ai/schemas.js";
import { config } from "../config.js";
import {
  insertPendingConfirmation,
  deletePendingById,
  type PendingConfirmationRow,
} from "../db/repositories/pendingConfirmations.js";
import { executeSave } from "./saveFlow.js";
import { toDisplayName } from "../ai/topicDetection.js";

interface ConfirmationCtx {
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
}

export interface ConfirmationPayload {
  triggeringPost: Post;
  triggeringUsername: string;
  thread: Post[];
  threadUsernamesObj: Record<string, string>;
  channelId: string;
  teamName: string;
  rawCommand: string;
}

interface RequestConfirmationOpts {
  detection: TopicDetection;
  triggeringPost: Post;
  triggeringUsername: string;
  thread: Post[];
  threadUsernames: Map<string, string>;
  channelId: string;
  teamName: string;
  rawCommand: string;
  ttlMinutes: number;
  ctx: ConfirmationCtx;
}

export async function requestConfirmation(
  opts: RequestConfirmationOpts,
): Promise<{ pendingId: number; botReplyPostId: string }> {
  const {
    detection,
    triggeringPost,
    triggeringUsername,
    thread,
    threadUsernames,
    channelId,
    teamName,
    rawCommand,
    ttlMinutes,
    ctx,
  } = opts;

  const altLines = detection.alternatives
    .slice(0, 2)
    .map((a) => `• ${a.topic_display_name}`);

  const messageLines = [
    `🤔 I think this belongs in **${detection.topic_display_name}**, but I'm not 100% sure.`,
    "",
    "React with 👍 to confirm, or reply with `#topic-name` to specify a different topic.",
  ];

  if (altLines.length > 0) {
    messageLines.push("");
    messageLines.push("Other possibilities I considered:");
    messageLines.push(...altLines);
  }

  messageLines.push("");
  messageLines.push(`(I'll forget about this if not confirmed within ${ttlMinutes} minutes.)`);

  const reply = await ctx.mmClient.createPost({
    channel_id: channelId,
    root_id: triggeringPost.root_id || triggeringPost.id,
    message: messageLines.join("\n"),
  });

  const payload: ConfirmationPayload = {
    triggeringPost,
    triggeringUsername,
    thread,
    threadUsernamesObj: Object.fromEntries(threadUsernames),
    channelId,
    teamName,
    rawCommand,
  };

  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  const row = insertPendingConfirmation({
    mm_channel_id: channelId,
    mm_thread_root_id: triggeringPost.root_id || triggeringPost.id,
    mm_trigger_post_id: triggeringPost.id,
    bot_reply_post_id: reply.id,
    triggered_by_user_id: triggeringPost.user_id,
    proposed_topic_slug: detection.topic_slug,
    proposed_topic_name: detection.topic_display_name,
    alternative_topics: JSON.stringify(detection.alternatives),
    payload_json: JSON.stringify(payload),
    expires_at: expiresAt,
  });

  ctx.logger.info(
    {
      pending_id: row.id,
      bot_reply_post_id: reply.id,
      proposed_topic_slug: detection.topic_slug,
      confidence: detection.confidence,
      expires_at: expiresAt,
    },
    "confirmation_requested",
  );

  return { pendingId: row.id, botReplyPostId: reply.id };
}

interface ResumeOpts {
  pending: PendingConfirmationRow;
  newTopicSlugOverride?: string;
  newTopicDisplayNameOverride?: string;
  ctx: ConfirmationCtx;
}

export async function resumeFromConfirmation(opts: ResumeOpts): Promise<void> {
  const { pending, newTopicSlugOverride, newTopicDisplayNameOverride, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(pending.payload_json) as ConfirmationPayload;
  } catch (err) {
    logger.error({ err, pending_id: pending.id }, "confirmation_payload_invalid_json");
    deletePendingById(pending.id);
    throw err;
  }

  const topicSlug = newTopicSlugOverride ?? pending.proposed_topic_slug;
  const topicDisplayName =
    newTopicDisplayNameOverride ??
    (newTopicSlugOverride ? toDisplayName(newTopicSlugOverride) : pending.proposed_topic_name);

  const threadUsernames = new Map(Object.entries(payload.threadUsernamesObj));

  try {
    const { documentUrl, topicDisplayName: finalDisplayName } = await executeSave({
      triggeringPost: payload.triggeringPost,
      triggeringUsername: payload.triggeringUsername,
      thread: payload.thread,
      threadUsernames,
      channelId: payload.channelId,
      teamName: payload.teamName,
      topicSlug,
      topicDisplayName,
      ctx: { mmClient, outlineClient, logger },
    });

    await mmClient.createPost({
      channel_id: payload.channelId,
      root_id: payload.triggeringPost.root_id || payload.triggeringPost.id,
      message: `✅ Saved to **${finalDisplayName}** → [open document](${documentUrl})`,
    });

    deletePendingById(pending.id);

    logger.info(
      {
        pending_id: pending.id,
        topic_slug: topicSlug,
        document_url: documentUrl,
        override: Boolean(newTopicSlugOverride),
      },
      "confirmation_resolved",
    );
  } catch (err) {
    logger.error({ err, pending_id: pending.id }, "confirmation_resume_failed");
    const shortError = (String(err instanceof Error ? err.message : err).split("\n")[0] ?? "").slice(0, 200);
    try {
      await mmClient.createPost({
        channel_id: payload.channelId,
        root_id: payload.triggeringPost.root_id || payload.triggeringPost.id,
        message: `⚠️ Sorry, something went wrong saving this thread: ${shortError}`,
      });
    } catch (replyErr) {
      logger.error({ err: replyErr }, "confirmation_resume_reply_failed");
    }
    // Drop the pending row regardless: the saves table's UNIQUE(mm_post_id) already blocks any retry,
    // so retaining the pending row would only let TTL cleanup nag and never resolve.
    deletePendingById(pending.id);
    throw err;
  }
}

export const CONFIRMATION_TTL_MINUTES = config.CONFIRMATION_TTL_MINUTES;
