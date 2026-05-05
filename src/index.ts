import { config } from "./config.js";
import { db, runMigrations } from "./db/index.js";
import { logger } from "./logger.js";

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

  // Phase 1+: Mattermost WS connection, dispatcher, handlers go here.
  logger.info("skeleton_running — Phase 0 only; further phases not yet implemented");

  // Stay alive so the container does not exit (until WS loop is added).
  await new Promise<never>(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, "fatal_error");
  process.exit(1);
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, "shutdown");
  try {
    db.close();
  } catch {
    // ignore
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
