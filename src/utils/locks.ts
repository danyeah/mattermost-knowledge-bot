// Serialize per-channel work so Outline collection creates and document mutations don't race on reconnect or rapid events.
const channelLocks = new Map<string, Promise<unknown>>();

export async function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  channelLocks.set(channelId, next);
  try { return await next; }
  finally { if (channelLocks.get(channelId) === next) channelLocks.delete(channelId); }
}
