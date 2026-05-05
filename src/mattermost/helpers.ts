import type { Post } from "./client.js";

export interface MentionResult {
  mentioned: boolean;
  afterMention: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the text contains a @mention matching any of the given triggers.
 * afterMention is the text after the first matched mention, trimmed.
 */
export function parseMention(text: string, triggers: string[]): MentionResult {
  if (triggers.length === 0) return { mentioned: false, afterMention: "" };

  const escaped = triggers.map((t) => escapeRegex(t.toLowerCase())).join("|");
  const pattern = new RegExp(`(^|\\s)@(${escaped})\\b`, "i");
  const match = pattern.exec(text);

  if (!match) return { mentioned: false, afterMention: "" };

  const matchEnd = match.index + match[0].length;
  const afterMention = text.slice(matchEnd).trim();
  return { mentioned: true, afterMention };
}

/**
 * Builds a Mattermost permalink URL for a given post.
 */
export function buildPermalink(mmUrl: string, teamName: string, postId: string): string {
  return `${mmUrl}/${teamName}/pl/${postId}`;
}

/**
 * Finds the first #hashtag (kebab-case slug) in text and returns the slug without #.
 * Returns null if none found.
 */
export function extractFirstHashtag(text: string): string | null {
  const match = /#([a-z][a-z0-9-]*)/.exec(text);
  return match ? (match[1] ?? null) : null;
}

/**
 * Sorts thread posts by create_at ascending, using the order array as a fallback tiebreaker.
 */
export function sortThreadPosts(thread: { order: string[]; posts: Record<string, Post> }): Post[] {
  return thread.order
    .map((id) => thread.posts[id])
    .filter((p): p is Post => p !== undefined)
    .sort((a, b) => a.create_at - b.create_at);
}
