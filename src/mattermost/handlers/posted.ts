import type { WsEvent } from "../websocket.js";
import type { MattermostClient, Post } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { parseMention, sortThreadPosts, extractFirstHashtag } from "../helpers.js";
import { findChannelByMmId } from "../../db/repositories/channels.js";
import { listTopicsByChannel, findTopicByChannelAndSlug } from "../../db/repositories/topics.js";
import {
  findActivePendingByThreadRoot,
  deletePendingById,
} from "../../db/repositories/pendingConfirmations.js";
import { db } from "../../db/index.js";
import { executeSave } from "../../core/saveFlow.js";
import { withChannelLock } from "../../utils/locks.js";
import { parseCommand } from "../../core/commandParser.js";
import { detectTopic, toDisplayName } from "../../ai/topicDetection.js";
import {
  requestConfirmation,
  resumeFromConfirmation,
} from "../../core/confirmationFlow.js";
import { formatUserError } from "../../utils/errorMessage.js";
import { search } from "../../search/retrieval.js";
import { generateAnswer } from "../../search/answerGeneration.js";

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
const lastSuccessfulSaveStmt = db.prepare(
  `SELECT s.created_at AS created_at, s.triggered_by_username AS username, t.topic_display_name AS topic_display_name
   FROM saves s LEFT JOIN topics t ON t.id = s.topic_id
   WHERE s.mm_channel_id = ? AND s.status = 'success'
   ORDER BY s.id DESC LIMIT 1`,
);

async function handleHashtagOverrideForPending(
  post: Post,
  ctx: PostedCtx,
): Promise<boolean> {
  const trimmed = post.message.trim();
  if (!trimmed.startsWith("#")) return false;

  const hashtag = extractFirstHashtag(trimmed);
  if (!hashtag) return false;

  const pending = findActivePendingByThreadRoot(post.root_id);
  if (!pending) return false;

  // Same-user guard: only the original requester may override their own pending confirmation.
  if (pending.triggered_by_user_id !== post.user_id) {
    ctx.logger.debug(
      { pending_id: pending.id, replied_by: post.user_id, original: pending.triggered_by_user_id },
      "hashtag_override_ignored_different_user",
    );
    return false;
  }

  ctx.logger.info(
    { pending_id: pending.id, hashtag },
    "confirmation_hashtag_override",
  );

  await withChannelLock(post.channel_id, async () => {
    const existingTopic = findTopicByChannelAndSlug(post.channel_id, hashtag);
    const displayName = existingTopic?.topic_display_name ?? toDisplayName(hashtag);

    await resumeFromConfirmation({
      pending,
      newTopicSlugOverride: hashtag,
      newTopicDisplayNameOverride: displayName,
      ctx: { mmClient: ctx.client, outlineClient: ctx.outlineClient, logger: ctx.logger },
    });
  });

  return true;
}

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

  if (post.root_id) {
    try {
      const handled = await handleHashtagOverrideForPending(post, ctx);
      if (handled) return;
    } catch (err) {
      logger.error({ err }, "hashtag_override_failed");
      return;
    }
  }

  const { mentioned, afterMention } = parseMention(post.message, config.BOT_TRIGGER_MENTIONS);

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

  const commandText = mentioned ? afterMention : post.message;

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
      root_id: post.root_id || post.id,
      message:
        "⚠️ This channel isn't configured for the knowledge bot. Try removing me from the channel and re-adding me.",
    });
    return;
  }

  const command = parseCommand(commandText);

  if (command.subcommand === "search") {
    const query = command.searchQuery;
    if (!query) {
      await client.createPost({
        channel_id: post.channel_id,
        root_id: post.root_id || post.id,
        message: `Uso: \`@${config.MM_BOT_USERNAME} cerca domanda\` — cerca nella wiki aziendale.`,
      });
      return;
    }

    const thinkingPost = await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id || post.id,
      message: `🔍 Cerco nella wiki: _${query}_…`,
    });

    try {
      const chunks = await search(query, 5);
      const topChunk = chunks[0];
      if (chunks.length === 0 || !topChunk || topChunk.score < 0.3) {
        await client.updatePost(thinkingPost.id, `❌ Nessun documento rilevante trovato per: _${query}_`);
        return;
      }

      const { answer, sources } = await generateAnswer(query, chunks);

      const seen = new Set<string>();
      const uniqueSources = sources.filter((s) => {
        const key = s.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const sourceLines = uniqueSources
        .map((s, i) => `[${i + 1}] [${s.title}${s.heading !== s.title ? ` › ${s.heading}` : ""}](${s.url})`)
        .join("\n");

      const reply = `${answer}\n\n**Fonti:**\n${sourceLines}`;
      await client.updatePost(thinkingPost.id, reply);

      logger.info({ query, chunks: chunks.length, topScore: topChunk.score }, "search_answered");
    } catch (err) {
      logger.error({ err, query }, "search_failed");
      await client.updatePost(thinkingPost.id, `⚠️ Errore durante la ricerca: ${formatUserError(err)}`);
    }
    return;
  }

  if (command.subcommand === "help") {
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id || post.id,
      message: `**Knowledge Bot commands:**
• \`@${config.MM_BOT_USERNAME}\` (in a thread reply) — salva il thread, rileva topic automaticamente
• \`@${config.MM_BOT_USERNAME} #topic-name\` — salva su un topic esplicito
• \`@${config.MM_BOT_USERNAME} cerca domanda\` — cerca nella wiki aziendale con AI
• \`@${config.MM_BOT_USERNAME} status\` — mostra le statistiche del canale
• \`@${config.MM_BOT_USERNAME} help\` — mostra questo messaggio

Documenti: ${config.OUTLINE_URL}`,
    });
    return;
  }

  if (command.subcommand === "status") {
    const collectionUrl = `${config.OUTLINE_URL}/collection/${channelRow.outline_collection_id}`;
    const topicsCount = listTopicsByChannel(post.channel_id).length;
    const lastSave = lastSuccessfulSaveStmt.get(post.channel_id) as
      | { created_at: string; username: string; topic_display_name: string | null }
      | undefined;
    const lastLine = lastSave
      ? `Last save: ${lastSave.created_at} by @${lastSave.username} → ${lastSave.topic_display_name ?? "(deleted topic)"}`
      : "Last save: none yet";

    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id || post.id,
      message: `📚 **${channelRow.mm_channel_name}** wiki status
Collection: [${channelRow.mm_channel_name}](${collectionUrl})
Topics: ${topicsCount}
${lastLine}`,
    });
    return;
  }

  // Default: subcommand === "save" — requires being a thread reply
  if (!post.root_id) {
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.id,
      message: `⚠️ To save a discussion, mention me as a **reply inside a thread**. Try \`@${config.MM_BOT_USERNAME} help\` for the available commands.`,
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
    const shortError = formatUserError(err);
    await client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id,
      message: `⚠️ Sorry, something went wrong saving this thread: ${shortError}`,
    });
    return;
  }

  await withChannelLock(post.channel_id, async () => {
    try {
      const existingTopics = listTopicsByChannel(post.channel_id).map((t) => ({
        slug: t.topic_slug,
        displayName: t.topic_display_name,
        summary: t.summary,
      }));

      const threadMessages = thread.map((p) => ({
        timestamp: new Date(p.create_at).toISOString(),
        username: userMap.get(p.user_id) ?? p.user_id,
        message: p.message,
      }));

      const detection = await detectTopic({
        channelName: channelRow.mm_channel_name,
        rawCommand: command.raw,
        explicitHashtag: command.explicitHashtag,
        existingTopics,
        threadMessages,
      });

      logger.info(
        {
          decision: detection.decision,
          topic_slug: detection.topic_slug,
          confidence: detection.confidence,
          explicit_hashtag: command.explicitHashtag,
        },
        "topic_detected",
      );

      const proceedDirectly =
        command.explicitHashtag !== null ||
        detection.confidence >= config.CONFIRMATION_CONFIDENCE_THRESHOLD;

      if (!proceedDirectly) {
        await requestConfirmation({
          detection,
          triggeringPost: post,
          triggeringUsername,
          thread,
          threadUsernames: userMap,
          channelId: post.channel_id,
          teamName,
          rawCommand: command.raw,
          ttlMinutes: config.CONFIRMATION_TTL_MINUTES,
          ctx: { mmClient: client, outlineClient, logger },
        });
        return;
      }

      const { documentUrl, topicDisplayName, channelDisplayName, changeSummary } = await executeSave({
        triggeringPost: post,
        triggeringUsername,
        thread,
        threadUsernames: userMap,
        channelId: post.channel_id,
        teamName,
        topicSlug: detection.topic_slug,
        topicDisplayName: detection.topic_display_name,
        ctx: { mmClient: client, outlineClient, logger },
      });

      const lingering = findActivePendingByThreadRoot(post.root_id);
      if (lingering) deletePendingById(lingering.id);

      await client.createPost({
        channel_id: post.channel_id,
        root_id: post.root_id,
        message: `✅ Saved to **${topicDisplayName}** in [${channelDisplayName}](${documentUrl})\n_${changeSummary}_`,
      });
      logger.info({ channel_id: post.channel_id, root_id: post.root_id, document_url: documentUrl }, "save_completed");
    } catch (err) {
      logger.error({ err }, "save_failed");
      const shortError = formatUserError(err);
      await client.createPost({
        channel_id: post.channel_id,
        root_id: post.root_id,
        message: `⚠️ Sorry, something went wrong saving this thread: ${shortError}`,
      });
    }
  });
}
