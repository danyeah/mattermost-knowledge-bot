import type { WsEvent } from "../websocket.js";
import type { MattermostClient, Post } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { parseMention, sortThreadPosts } from "../helpers.js";
import { findChannelByMmId } from "../../db/repositories/channels.js";
import { db } from "../../db/index.js";
import { executeSave } from "../../core/saveFlow.js";
import { withChannelLock } from "../../utils/locks.js";

interface PostedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  config: Config;
  logger: Logger;
  botUserId: string;
  teamName: string;
}

type PostedEvent = Extract<WsEvent, { event: "posted" }>;

const checkExistingSaveStmt = db.prepare("SELECT id FROM saves WHERE mm_post_id = ?");

export async function handlePosted(event: PostedEvent, ctx: PostedCtx): Promise<void> {
  const { client, outlineClient, config, logger, botUserId, teamName } = ctx;

  let post: Post;
  try {
    post = JSON.parse(event.data.post) as Post;
  } catch {
    logger.warn({ raw: event.data.post }, "posted_invalid_json");
    return;
  }

  if (post.user_id === botUserId) return;

  if (!post.root_id) return;

  const { mentioned } = parseMention(post.message, config.BOT_TRIGGER_MENTIONS);

  let mentionedViaProps = false;
  if (!mentioned) {
    const rawMentions = post.props["mentions"];
    if (rawMentions !== undefined) {
      let mentions: unknown = rawMentions;
      if (typeof mentions === "string") {
        try {
          mentions = JSON.parse(mentions);
        } catch {
          mentions = [];
        }
      }
      if (Array.isArray(mentions)) {
        mentionedViaProps = (mentions as unknown[]).includes(botUserId);
      }
    }
  }

  if (!mentioned && !mentionedViaProps) return;

  logger.info(
    { post_id: post.id, channel_id: post.channel_id, root_id: post.root_id, user_id: post.user_id },
    "posted_bot_mentioned",
  );

  const existingSave = checkExistingSaveStmt.get(post.id);
  if (existingSave) {
    logger.info({ post_id: post.id }, "posted_already_saved_skipping");
    return;
  }

  const channelRow = findChannelByMmId(post.channel_id);
  if (!channelRow) {
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id,
      message:
        "⚠️ This channel isn't configured for the knowledge bot. Try removing me from the channel and re-adding me.",
    });
    return;
  }

  let thread: Post[];
  let userMap: Map<string, string>;
  let triggeringUsername: string;

  try {
    const threadData = await client.getThread(post.root_id);
    thread = sortThreadPosts(threadData);

    const userIds = [...new Set(thread.map((p) => p.user_id))];
    const usersArr = await client.getUsersByIds(userIds);
    userMap = new Map(usersArr.map((u) => [u.id, u.username]));
    triggeringUsername = userMap.get(post.user_id) ?? post.user_id;

    logger.info({ thread_id: post.root_id, post_count: thread.length }, "thread_fetched");
  } catch (err) {
    logger.error({ err, root_id: post.root_id }, "thread_fetch_failed");
    const shortError = (String(err instanceof Error ? err.message : err).split("\n")[0] ?? "").slice(0, 200);
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id,
      message: `⚠️ Sorry, something went wrong saving this thread: ${shortError}`,
    });
    return;
  }

  await withChannelLock(post.channel_id, async () => {
    try {
      const { documentUrl, topicDisplayName } = await executeSave({
        triggeringPost: post,
        triggeringUsername,
        thread,
        threadUsernames: userMap,
        channelId: post.channel_id,
        teamName,
        ctx: { mmClient: client, outlineClient, logger },
      });

      await client.createPost({
        channel_id: post.channel_id,
        root_id: post.root_id,
        message: `✅ Saved to **${topicDisplayName}** → [open document](${documentUrl})`,
      });
      logger.info({ channel_id: post.channel_id, root_id: post.root_id, document_url: documentUrl }, "save_completed");
    } catch (err) {
      logger.error({ err }, "save_failed");
      const shortError = (String(err instanceof Error ? err.message : err).split("\n")[0] ?? "").slice(0, 200);
      await client.createPost({
        channel_id: post.channel_id,
        root_id: post.root_id,
        message: `⚠️ Sorry, something went wrong saving this thread: ${shortError}`,
      });
    }
  });
}
