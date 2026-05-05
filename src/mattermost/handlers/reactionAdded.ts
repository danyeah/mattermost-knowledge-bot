import type { WsEvent } from "../websocket.js";
import type { MattermostClient } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Logger } from "../../logger.js";
import { findPendingByBotReplyId } from "../../db/repositories/pendingConfirmations.js";
import { resumeFromConfirmation } from "../../core/confirmationFlow.js";
import { withChannelLock } from "../../utils/locks.js";

interface ReactionAddedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

type ReactionAddedEvent = Extract<WsEvent, { event: "reaction_added" }>;

interface Reaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

const CONFIRM_EMOJIS = new Set(["+1", "thumbsup"]);

export async function handleReactionAdded(event: ReactionAddedEvent, ctx: ReactionAddedCtx): Promise<void> {
  const { client, outlineClient, logger, botUserId } = ctx;

  let reaction: Reaction;
  try {
    const raw = event.data.reaction;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("post_id" in parsed) ||
      !("user_id" in parsed) ||
      !("emoji_name" in parsed)
    ) {
      logger.debug({ raw }, "reaction_added_missing_fields");
      return;
    }
    reaction = parsed as Reaction;
  } catch {
    logger.warn({ raw: event.data.reaction }, "reaction_added_invalid_json");
    return;
  }

  if (!CONFIRM_EMOJIS.has(reaction.emoji_name)) return;
  if (reaction.user_id === botUserId) return;

  const pending = findPendingByBotReplyId(reaction.post_id);
  if (!pending) return;

  logger.info(
    {
      pending_id: pending.id,
      post_id: reaction.post_id,
      user_id: reaction.user_id,
      emoji: reaction.emoji_name,
    },
    "confirmation_reaction_received",
  );

  await withChannelLock(pending.mm_channel_id, async () => {
    try {
      await resumeFromConfirmation({
        pending,
        ctx: { mmClient: client, outlineClient, logger },
      });
    } catch (err) {
      logger.error({ err, pending_id: pending.id }, "confirmation_reaction_resume_failed");
    }
  });
}
