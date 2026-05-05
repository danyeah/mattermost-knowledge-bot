import type { WsEvent } from "../websocket.js";
import type { MattermostClient } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Logger } from "../../logger.js";
import { config } from "../../config.js";
import { findChannelByMmId, insertChannel } from "../../db/repositories/channels.js";
import { createCollection } from "../../outline/collections.js";

interface UserAddedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

type UserAddedEvent = Extract<WsEvent, { event: "user_added" }>;

export async function handleUserAdded(event: UserAddedEvent, ctx: UserAddedCtx): Promise<void> {
  const { client, outlineClient, logger, botUserId } = ctx;

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

    const existing = findChannelByMmId(channelId);
    if (existing) {
      const collectionUrl = `${config.OUTLINE_URL}/collection/${existing.outline_collection_id}`;
      await client.createPost({
        channel_id: channelId,
        message: `👋 Already configured, knowledge base is here: ${collectionUrl}`,
      });
      return;
    }

    const collection = await createCollection(outlineClient, {
      name: channel.display_name || channel.name,
      description: `Knowledge base for #${channel.name}`,
    });

    insertChannel({
      mm_channel_id: channel.id,
      mm_channel_name: channel.name,
      outline_collection_id: collection.id,
      created_by_user_id: botUserId,
    });

    logger.info(
      { channel_id: channel.id, collection_id: collection.id },
      "outline_collection_created",
    );

    const collectionUrl = `${config.OUTLINE_URL}/collection/${collection.urlId ?? collection.id}`;

    await client.createPost({
      channel_id: channelId,
      message: `👋 Hi! I'm the Knowledge Bot. I just created a wiki collection for this channel: ${collectionUrl}

To save knowledge from a discussion, **reply to a thread** and tag me:
• \`@wikibot\` — I'll auto-detect the topic
• \`@wikibot #topic-name\` — to specify the topic explicitly
• \`@wikibot help\` — show all commands`,
    });
  } catch (err) {
    logger.error({ err, channel_id: channelId }, "user_added_handler_failed");
  }
}
