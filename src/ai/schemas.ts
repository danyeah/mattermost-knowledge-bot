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

export type TopicDetection = z.infer<typeof TopicDetectionSchema>;
