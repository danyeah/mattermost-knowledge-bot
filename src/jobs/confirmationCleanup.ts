import type { Logger } from "../logger.js";
import { deleteExpiredPending } from "../db/repositories/pendingConfirmations.js";

export function startConfirmationCleanup(
  intervalMinutes: number,
  logger: Logger,
): { stop: () => void } {
  const intervalMs = intervalMinutes * 60_000;

  function tick(): void {
    try {
      const removed = deleteExpiredPending(new Date().toISOString());
      if (removed > 0) {
        logger.info({ removed }, "confirmation_cleanup_swept");
      } else {
        logger.debug({ removed }, "confirmation_cleanup_swept");
      }
    } catch (err) {
      logger.error({ err }, "confirmation_cleanup_failed");
    }
  }

  tick();
  const handle = setInterval(tick, intervalMs);

  logger.info({ interval_minutes: intervalMinutes }, "confirmation_cleanup_started");

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
