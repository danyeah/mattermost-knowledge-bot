import type { OutlineClient } from "../outline/client.js";
import { runFullSync } from "../indexer/outlineIndexer.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

export function startIndexSync(outlineClient: OutlineClient): void {
  const intervalMs = config.INDEX_SYNC_INTERVAL_MINUTES * 60 * 1000;

  const run = async () => {
    try {
      await runFullSync(outlineClient);
    } catch (err) {
      logger.error({ err }, "index_sync_job_failed");
    }
  };

  // Initial sync after 30s to let Ollama fully start
  setTimeout(() => { void run(); }, 30_000);
  setInterval(() => { void run(); }, intervalMs);

  logger.info({ intervalMinutes: config.INDEX_SYNC_INTERVAL_MINUTES }, "index_sync_scheduled");
}
