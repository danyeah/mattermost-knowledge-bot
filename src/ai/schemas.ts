import { z } from "zod";

export const TopicDetectionSchema = z.object({
  decision: z.enum(["match_existing", "create_new"]),
  topic_slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  topic_display_name: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  alternatives: z
    .array(
      z.object({
        topic_slug: z.string(),
        topic_display_name: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  reasoning: z.string(),
});

// Claude occasionally returns section bodies as JSON arrays even though the prompt
// asks for markdown strings. Coerce arrays to bullet-list strings before validation
// so a structurally-valid response isn't rejected over a formatting choice.
const sectionField = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? v
          .map((item) => (typeof item === "string" ? `- ${item}` : `- ${JSON.stringify(item)}`))
          .join("\n")
      : v,
  z.string().nullable(),
);

export const SectionMergeSchema = z.object({
  summary: sectionField,
  decisions: sectionField,
  technical_details: sectionField,
  operational_notes: sectionField,
  references: sectionField,
  change_summary: z.string(),
});

export type TopicDetection = z.infer<typeof TopicDetectionSchema>;
export type SectionMerge = z.infer<typeof SectionMergeSchema>;
