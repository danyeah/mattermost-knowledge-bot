import { config } from "./config.js";
import { db, runMigrations } from "./db/index.js";
import { logger } from "./logger.js";
import { MattermostClient } from "./mattermost/client.js";
import { MattermostWebSocket, type WsEvent } from "./mattermost/websocket.js";
import { OutlineClient } from "./outline/client.js";
import { handlePosted } from "./mattermost/handlers/posted.js";
import { handleUserAdded } from "./mattermost/handlers/userAdded.js";
import { handleReactionAdded } from "./mattermost/handlers/reactionAdded.js";
import { startConfirmationCleanup } from "./jobs/confirmationCleanup.js";
import { startIndexSync } from "./jobs/indexSync.js";
import { ensureModelReady } from "./embedding/client.js";

async function main(): Promise<void> {
  logger.info(
    { mm_url: config.MM_URL, outline_url: config.OUTLINE_URL, model: config.ANTHROPIC_MODEL },
    "bot_started",
  );

  runMigrations();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
  logger.info({ tables }, "db_ready");

  const client = new MattermostClient(config.MM_URL, config.MM_BOT_TOKEN, logger);
  const outlineClient = new OutlineClient(config.OUTLINE_URL, config.OUTLINE_API_TOKEN, logger);

  let botUserId = config.MM_BOT_USER_ID;
  if (!botUserId) {
    const me = await client.me();
    botUserId = me.id;
    logger.warn(
      { user_id: botUserId, username: me.username },
      "MM_BOT_USER_ID not set in .env — resolved from API. Consider setting MM_BOT_USER_ID in .env to avoid this call.",
    );
  }

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

  function dispatch(event: WsEvent): void {
    logger.debug({ event: event.event }, "ws_event_received");

    const ctx = { client, outlineClient, config, logger, botUserId, teamName };

    void (async () => {
      try {
        switch (event.event) {
          case "posted":
            await handlePosted(event as Extract<WsEvent, { event: "posted" }>, ctx);
            break;

          case "user_added":
            await handleUserAdded(event as Extract<WsEvent, { event: "user_added" }>, {
              client,
              outlineClient,
              logger,
              botUserId,
            });
            break;

          case "reaction_added":
            await handleReactionAdded(event as Extract<WsEvent, { event: "reaction_added" }>, {
              client,
              outlineClient,
              logger,
              botUserId,
            });
            break;

          default:
            logger.debug({ event: event.event }, "ws_unhandled_event");
        }
      } catch (err) {
        logger.error({ err, event: event.event }, "handler_error");
      }
    })();
  }

  const ws = new MattermostWebSocket({
    url: config.MM_URL,
    token: config.MM_BOT_TOKEN,
    logger,
    dispatch,
  });

  const cleanupJob = startConfirmationCleanup(config.CLEANUP_INTERVAL_MINUTES, logger);

  // Start embedding model check + Outline index sync
  try {
    await ensureModelReady();
  } catch (err) {
    logger.warn({ err }, "embedding_model_not_ready_search_disabled");
  }
  startIndexSync(outlineClient);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutdown");
    cleanupJob.stop();
    ws.close();
    try {
      db.close();
    } catch (err) {
      logger.error({ err }, "db_close_failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("ws_connecting_start");
  ws.connect();

  await new Promise<never>(() => {});
}

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled_rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught_exception");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, "fatal_error");
  process.exit(1);
});
