import type { WsEvent } from "../websocket.js";
import type { MattermostClient } from "../client.js";
import type { Logger } from "../../logger.js";

interface UserAddedCtx {
  client: MattermostClient;
  logger: Logger;
  botUserId: string;
}

type UserAddedEvent = Extract<WsEvent, { event: "user_added" }>;

export async function handleUserAdded(event: UserAddedEvent, ctx: UserAddedCtx): Promise<void> {
  const { client, logger, botUserId } = ctx;

  // Only care if it's the bot being added
  if (event.data.user_id !== botUserId) return;

  const channelId = event.broadcast.channel_id;

  try {
    const channel = await client.getChannel(channelId);
    logger.info(
      {
        channel_id: channel.id,
        channel_name: channel.name,
        display_name: channel.display_name,
        team_id: channel.team_id,
      },
      "bot_added_to_channel",
    );

    // TODO Phase 2: create (or link) an Outline collection for this channel.
  } catch (err) {
    logger.error({ err, channel_id: channelId }, "user_added_channel_fetch_failed");
  }
}
