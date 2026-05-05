import type { WsEvent } from "../websocket.js";
import type { Logger } from "../../logger.js";

interface ReactionAddedCtx {
  logger: Logger;
}

type ReactionAddedEvent = Extract<WsEvent, { event: "reaction_added" }>;

interface Reaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

// Stub handler — Phase 3 will implement save-to-Outline on specific emoji reactions.
export async function handleReactionAdded(event: ReactionAddedEvent, ctx: ReactionAddedCtx): Promise<void> {
  const { logger } = ctx;

  let reaction: Reaction;
  try {
    reaction = JSON.parse(event.data.reaction) as Reaction;
  } catch {
    logger.warn({ raw: event.data.reaction }, "reaction_added_invalid_json");
    return;
  }

  logger.debug(
    {
      user_id: reaction.user_id,
      post_id: reaction.post_id,
      emoji: reaction.emoji_name,
    },
    "reaction_added",
  );

  // TODO Phase 3: if emoji matches configured save-trigger (e.g. 📌), start save flow.
}
