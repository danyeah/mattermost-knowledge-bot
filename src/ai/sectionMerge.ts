import { logger } from "../logger.js";
import { callModel } from "./client.js";
import { stripJsonFences } from "./jsonExtract.js";
import { SectionMergeSchema, type SectionMerge } from "./schemas.js";
import type { DocumentSections } from "../core/documentBuilder.js";

export interface SectionMergeInput {
  todayIso: string;
  topicDisplayName: string;
  existingSections: DocumentSections;
  threadMessages: Array<{ timestamp: string; username: string; message: string }>;
  /** Text of files attached to the thread (PDF/DOCX/MD already extracted).
   * Treated as authoritative source material — much richer than chat text. */
  attachedDocuments?: Array<{ filename: string; text: string }>;
}

const MAX_DOC_CHARS = 8000;       // per-document cap to keep prompt size bounded
const MAX_TOTAL_DOC_CHARS = 20000; // hard cap across all docs in one merge

const SECTION_MERGE_SYSTEM_PROMPT = `You are a technical writer maintaining a structured knowledge base for a
software team. You receive an existing document's curated sections and a new
discussion thread, and you produce updated section content that integrates
the new information cleanly.

You MUST respond with a single JSON object and nothing else. No prose, no
markdown fences. The JSON must conform exactly to this schema:

{
  "summary": "string (3-5 sentences) | null",
  "decisions": "string (markdown bullet list) | null",
  "technical_details": "string (markdown) | null",
  "operational_notes": "string (markdown) | null",
  "references": "string (markdown bullet list) | null",
  "change_summary": "string (one-line description of what changed)"
}

Rules:
- Return null for sections you decide NOT to modify. Returned non-null values
  REPLACE the corresponding section in full.
- Preserve the language of the source content. If the existing document is
  in Italian and the new thread is in Italian, write in Italian. If mixed,
  preserve each item in its original language.
- Be concise and factual. Do not invent details not present in the inputs.
- For "decisions": prefix each bullet with the date in ISO format (YYYY-MM-DD)
  if a date is mentioned or inferable, otherwise use today's date provided.
- For "technical_details": use fenced code blocks for code, API specs, configs.
  Use sub-headings (###) liberally to organize.
- For "references": use markdown links. Keep existing references and add new
  ones; deduplicate.
- "summary" should be a fresh rewrite reflecting the full topic state, not just
  the new addition.
- If the new thread doesn't add meaningful new info to a section, leave that
  section null.
- ATTACHED DOCUMENTS, when present, are authoritative source material that
  should dominate section content. Extract Summary, Decisions, Technical
  details, Operational notes and References from those documents — do not
  treat them as mere file links. Chat messages provide context around the
  documents.
- "change_summary" is a single sentence describing the net change, used in
  Mattermost reply and audit logs.
- Every section value MUST be a single JSON string containing markdown, OR null.
  NEVER return a JSON array of strings — even for bullet lists, emit one string
  containing newline-separated markdown bullets (e.g. "- first bullet\\n- second bullet").`;

// Present plain "(empty)" rather than the italic markup stored in the file,
// so the model never echoes raw markdown syntax back.
const EMPTY_PLACEHOLDER = "(empty)";

function renderForPrompt(section: string | null): string {
  if (section === null) return EMPTY_PLACEHOLDER;
  const trimmed = section.trim();
  return trimmed.length > 0 ? trimmed : EMPTY_PLACEHOLDER;
}

function buildUserPrompt(input: SectionMergeInput): string {
  const lines: string[] = [];
  lines.push(`TODAY: ${input.todayIso}`);
  lines.push(`TOPIC: ${input.topicDisplayName}`);
  lines.push("");
  lines.push("EXISTING SECTIONS (current state of the document; sections may be empty):");
  lines.push("");
  lines.push("### Summary");
  lines.push(renderForPrompt(input.existingSections.summary));
  lines.push("");
  lines.push("### Decisions");
  lines.push(renderForPrompt(input.existingSections.decisions));
  lines.push("");
  lines.push("### Technical details");
  lines.push(renderForPrompt(input.existingSections.technical_details));
  lines.push("");
  lines.push("### Operational notes");
  lines.push(renderForPrompt(input.existingSections.operational_notes));
  lines.push("");
  lines.push("### References");
  lines.push(renderForPrompt(input.existingSections.references));
  lines.push("");
  lines.push("NEW THREAD TO INTEGRATE (chronological):");
  for (const m of input.threadMessages) {
    lines.push(`[${m.timestamp}] @${m.username}: ${m.message}`);
  }
  lines.push("");

  if (input.attachedDocuments && input.attachedDocuments.length > 0) {
    lines.push("ATTACHED DOCUMENTS (extracted text — authoritative for section content):");
    let remainingBudget = MAX_TOTAL_DOC_CHARS;
    for (const doc of input.attachedDocuments) {
      if (remainingBudget <= 0) {
        lines.push(`### ${doc.filename}`);
        lines.push("[omitted: prompt size budget exhausted]");
        lines.push("");
        continue;
      }
      const cap = Math.min(MAX_DOC_CHARS, remainingBudget);
      const text = doc.text.length > cap ? doc.text.slice(0, cap) + "\n…[truncated]" : doc.text;
      lines.push(`### ${doc.filename}`);
      lines.push(text);
      lines.push("");
      remainingBudget -= text.length;
    }
  }

  lines.push("Produce the updated sections.");
  return lines.join("\n");
}

function tryParse(text: string): SectionMerge | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (err) {
    return { error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = SectionMergeSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `Schema validation failed: ${result.error.message}` };
  }
  return result.data;
}

export async function mergeSections(input: SectionMergeInput): Promise<SectionMerge> {
  const userPrompt = buildUserPrompt(input);

  const first = await callModel({
    systemPrompt: SECTION_MERGE_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 8000,
    temperature: 0.3,
  });

  const firstAttempt = tryParse(first.text);
  if (!("error" in firstAttempt)) {
    logger.info(
      {
        change_summary: firstAttempt.change_summary,
        tokens_in: first.usage.input,
        tokens_out: first.usage.output,
        attempts: 1,
      },
      "ai_section_merge_completed",
    );
    return firstAttempt;
  }

  logger.warn(
    { err: firstAttempt.error, response: first.text.slice(0, 500) },
    "ai_section_merge_parse_failed_retrying",
  );

  const retryPrompt = `${userPrompt}

Your previous response was not valid JSON or did not match the required schema. Please retry, returning ONLY the JSON object. Previous response: ${first.text}`;

  const second = await callModel({
    systemPrompt: SECTION_MERGE_SYSTEM_PROMPT,
    userPrompt: retryPrompt,
    maxTokens: 8000,
    temperature: 0.3,
  });

  const secondAttempt = tryParse(second.text);
  if ("error" in secondAttempt) {
    logger.error(
      {
        first_error: firstAttempt.error,
        second_error: secondAttempt.error,
        second_response: second.text.slice(0, 500),
      },
      "ai_section_merge_failed",
    );
    throw new Error(`Section merge failed after retry: ${secondAttempt.error}`);
  }

  logger.info(
    {
      change_summary: secondAttempt.change_summary,
      tokens_in: first.usage.input + second.usage.input,
      tokens_out: first.usage.output + second.usage.output,
      attempts: 2,
    },
    "ai_section_merge_completed",
  );
  return secondAttempt;
}
