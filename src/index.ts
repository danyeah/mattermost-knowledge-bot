import { config } from "./config.js";
import { db, runMigrations } from "./db/index.js";
import { logger } from "./logger.js";
import { MattermostClient } from "./mattermost/client.js";
import { MattermostWebSocket, type WsEvent } from "./mattermost/websocket.js";
import { handlePosted } from "./mattermost/handlers/posted.js";
import { handleUserAdded } from "./mattermost/handlers/userAdded.js";
import { handleReactionAdded } from "./mattermost/handlers/reactionAdded.js";

async function main(): Promise<void> {
  logger.info(
    { mm_url: config.MM_URL, outline_url: config.OUTLINE_URL, model: config.ANTHROPIC_MODEL },
    "bot_started",
  );

  // 1. Run DB migrations
  runMigrations();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
  logger.info({ tables }, "db_ready");

  // 2. Create Mattermost REST client
  const client = new MattermostClient(config.MM_URL, config.MM_BOT_TOKEN, logger);

  // 3. Resolve bot user ID (from config or API)
  let botUserId = config.MM_BOT_USER_ID;
  if (!botUserId) {
    const me = await client.me();
    botUserId = me.id;
    logger.warn(
      { user_id: botUserId, username: me.username },
      "MM_BOT_USER_ID not set in .env — resolved from API. Consider setting MM_BOT_USER_ID in .env to avoid this call.",
    );
  }

  // 4. Discover primary team for permalink building
  let teamName = "";
  try {
    const teams = await client.getMyTeams();
    const primaryTeam = teams[0];
    if (primaryTeam) {
      teamName = primaryTeam.name;
      logger.info({ team_id: primaryTeam.id, team_name: teamName }, "primary_team_resolved");
    } else {
      logger.warn("bot_has_no_teams — permalinks will be empty");
    }
  } catch (err) {
    logger.error({ err }, "team_fetch_failed");
  }

  // 5. Build WS event dispatcher
  function dispatch(event: WsEvent): void {
    logger.debug({ event: event.event }, "ws_event_received");

    const ctx = { client, config, logger, botUserId };

    void (async () => {
      try {
        switch (event.event) {
          case "posted":
            // Safe: switch narrowed by event.event literal
            await handlePosted(event as Extract<WsEvent, { event: "posted" }>, ctx);
            break;

          case "user_added":
            await handleUserAdded(event as Extract<WsEvent, { event: "user_added" }>, { client, logger, botUserId });
            break;

          case "reaction_added":
            await handleReactionAdded(event as Extract<WsEvent, { event: "reaction_added" }>, { logger });
            break;

          default:
            logger.debug({ event: event.event }, "ws_unhandled_event");
        }
      } catch (err) {
        logger.error({ err, event: event.event }, "handler_error");
      }
    })();
  }

  // 6. Start WebSocket connection
  const ws = new MattermostWebSocket({
    url: config.MM_URL,
    token: config.MM_BOT_TOKEN,
    logger,
    dispatch,
  });

  // Register shutdown before starting the WS loop so signals are handled cleanly
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutdown");
    ws.close();
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("ws_connecting_start");
  ws.connect();

  // Keep process alive — the WS reconnect loop is async; we park here indefinitely.
  // Shutdown is handled via signals above.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, "fatal_error");
  process.exit(1);
});
