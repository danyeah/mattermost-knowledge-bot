import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  MM_URL: z.string().url(),
  MM_BOT_TOKEN: z.string().min(20),
  MM_BOT_USERNAME: z.string().min(1),
  MM_BOT_USER_ID: z.string().optional().default(""),

  OUTLINE_URL: z.string().url(),
  OUTLINE_API_TOKEN: z.string().min(20),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // When set, use this OpenAI-compatible endpoint instead of Anthropic
  LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  LLM_MODEL: z.string().default("Qwen3.6-27B-UD-Q4_K_XL.gguf"),

  OLLAMA_URL: z.string().url().default("http://ollama:11434"),
  INDEX_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),

  BOT_TRIGGER_MENTIONS: z
    .string()
    .default("wikibot,kb,knowledge-bot")
    .transform((s) =>
      s
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  CONFIRMATION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  CONFIRMATION_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),

  DB_PATH: z.string().default("./data/kb-bot.db"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
