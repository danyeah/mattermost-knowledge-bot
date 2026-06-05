import { logger } from "../logger.js";
import { callModel } from "./client.js";
import { stripJsonFences } from "./jsonExtract.js";
import { TopicDetectionSchema, type TopicDetection } from "./schemas.js";

export interface TopicDetectionInput {
  channelName: string;
  rawCommand: string;
  explicitHashtag: string | null;
  existingTopics: Array<{ slug: string; displayName: string; summary: string | null }>;
  threadMessages: Array<{ timestamp: string; username: string; message: string }>;
}

const TOPIC_DETECTION_SYSTEM_PROMPT = `You are a knowledge management assistant for a software development team.
Your job is to classify a Mattermost discussion thread into the right topic
within a project's knowledge base.

You MUST respond with a single JSON object and nothing else. No prose, no
markdown fences. The JSON must conform exactly to this schema:

{
  "decision": "match_existing" | "create_new",
  "topic_slug": "kebab-case-slug",
  "topic_display_name": "Human Readable Title",
  "confidence": 0.0 to 1.0,
  "alternatives": [
    { "topic_slug": "...", "topic_display_name": "...", "reason": "..." }
  ],
  "reasoning": "one short sentence explaining your choice"
}

Rules:
- "match_existing": pick this when the thread clearly fits one of the existing
  topics provided. Use the exact slug from the existing list.
- "create_new": pick this when no existing topic fits well. Propose a new
  kebab-case slug and a clear display name.
- topic_slug is always kebab-case, ASCII, max 60 chars.
- topic_display_name preserves the language of the thread content.
- "alternatives" lists up to 2 other plausible topics (existing or new) when
  the choice is non-obvious. Empty array if confidence is high.
- confidence reflects how sure you are: >0.85 means very sure, 0.6-0.85 means
  plausible but ambiguous, <0.6 means uncertain.
- If the user explicitly specified a topic via #hashtag in their command, that
  hashtag is authoritative: use it as the slug, and find or create accordingly,
  with confidence 1.0.`;

function buildUserPrompt(input: TopicDetectionInput): string {
  const lines: string[] = [];
  // `/no_think` first — see Decide line below for rationale.
  lines.push("/no_think");
  lines.push("");
  lines.push(`PROJECT (Mattermost channel): ${input.channelName}`);
  lines.push("");
  lines.push(`USER COMMAND: ${input.rawCommand}`);
  lines.push(`EXPLICIT TOPIC HASHTAG (if any): ${input.explicitHashtag ?? "none"}`);
  lines.push("");
  lines.push("EXISTING TOPICS IN THIS PROJECT:");
  if (input.existingTopics.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of input.existingTopics) {
      lines.push(`- slug: ${t.slug}`);
      lines.push(`  name: ${t.displayName}`);
      lines.push(`  summary: ${t.summary && t.summary.trim() ? t.summary : "no_summary"}`);
    }
  }
  lines.push("");
  lines.push("THREAD CONTENT (chronological, oldest first):");
  for (const m of input.threadMessages) {
    lines.push(`[${m.timestamp}] @${m.username}: ${m.message}`);
  }
  lines.push("");
  lines.push("Decide the topic for this thread.");
  return lines.join("\n");
}

export function toDisplayName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => (part.length === 0 ? part : (part[0]?.toUpperCase() ?? "") + part.slice(1)))
    .join(" ");
}

function tryParse(text: string): TopicDetection | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (err) {
    return { error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = TopicDetectionSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `Schema validation failed: ${result.error.message}` };
  }
  return result.data;
}

export async function detectTopic(input: TopicDetectionInput): Promise<TopicDetection> {
  if (input.explicitHashtag) {
    const slug = input.explicitHashtag;
    const matching = input.existingTopics.find((t) => t.slug === slug);
    return {
      decision: matching ? "match_existing" : "create_new",
      topic_slug: slug,
      topic_display_name: matching?.displayName ?? toDisplayName(slug),
      confidence: 1.0,
      alternatives: [],
      reasoning: "explicit hashtag provided",
    };
  }

  const userPrompt = buildUserPrompt(input);

  const first = await callModel({
    systemPrompt: TOPIC_DETECTION_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800,
    temperature: 0.2,
  });

  const firstAttempt = tryParse(first.text);
  if (!("error" in firstAttempt)) {
    logger.info(
      {
        decision: firstAttempt.decision,
        confidence: firstAttempt.confidence,
        tokens_in: first.usage.input,
        tokens_out: first.usage.output,
        attempts: 1,
      },
      "ai_topic_detection_completed",
    );
    return firstAttempt;
  }

  logger.warn({ err: firstAttempt.error, response: first.text.slice(0, 500) }, "ai_topic_detection_parse_failed_retrying");

  const retryPrompt = `${userPrompt}

Your previous response was not valid JSON or did not match the required schema. Please retry, returning ONLY the JSON object. Previous response: ${first.text}`;

  const second = await callModel({
    systemPrompt: TOPIC_DETECTION_SYSTEM_PROMPT,
    userPrompt: retryPrompt,
    maxTokens: 800,
    temperature: 0.2,
  });

  const secondAttempt = tryParse(second.text);
  if ("error" in secondAttempt) {
    logger.error(
      {
        first_error: firstAttempt.error,
        second_error: secondAttempt.error,
        second_response: second.text.slice(0, 500),
      },
      "ai_topic_detection_failed",
    );
    throw new Error(`Topic detection failed after retry: ${secondAttempt.error}`);
  }

  logger.info(
    {
      decision: secondAttempt.decision,
      confidence: secondAttempt.confidence,
      tokens_in: first.usage.input + second.usage.input,
      tokens_out: first.usage.output + second.usage.output,
      attempts: 2,
    },
    "ai_topic_detection_completed",
  );
  return secondAttempt;
}
