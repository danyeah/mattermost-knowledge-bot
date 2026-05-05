import type { WsEvent } from "../websocket.js";
import type { MattermostClient, Post } from "../client.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { parseMention, sortThreadPosts } from "../helpers.js";

interface PostedCtx {
  client: MattermostClient;
  config: Config;
  logger: Logger;
  botUserId: string;
}

type PostedEvent = Extract<WsEvent, { event: "posted" }>;

export async function handlePosted(event: PostedEvent, ctx: PostedCtx): Promise<void> {
  const { client, config, logger, botUserId } = ctx;

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

  try {
    const thread = await client.getThread(post.root_id);
    const posts = sortThreadPosts(thread);

    const userIds = [...new Set(posts.map((p) => p.user_id))];
    const usersArr = await client.getUsersByIds(userIds);
    const userMap = new Map(usersArr.map((u) => [u.id, u.username]));

    const threadSummary = posts.map((p) => ({
      id: p.id,
      user: userMap.get(p.user_id) ?? p.user_id,
      ts: new Date(p.create_at).toISOString(),
      message: p.message.slice(0, 200),
    }));

    logger.info({ thread_id: post.root_id, post_count: posts.length, posts: threadSummary }, "thread_fetched");
  } catch (err) {
    logger.error({ err, root_id: post.root_id }, "thread_fetch_failed");
  }

  try {
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id,
      message: "I see you 👀",
    });
    logger.info({ channel_id: post.channel_id, root_id: post.root_id }, "posted_reply_sent");
  } catch (err) {
    logger.error({ err }, "posted_reply_failed");
  }
}
