# Mattermost Knowledge Bot — Implementation Plan

**Target executor**: AI coding agent
**Project owner**: Daniel (Scaling Parrots)
**Goal**: Build a Mattermost bot that, when mentioned in a thread reply, captures the thread content and progressively builds a structured knowledge wiki on Outline, organized by project (Mattermost channel) and topic.

---

## 0. High-level overview

### What the bot does

1. When invited to a Mattermost channel, it auto-creates a corresponding Outline collection named after the channel.
2. When a user replies to a thread tagging the bot (e.g. `@kb` or `@kb #topic-name`), the bot fetches the entire thread, uses Claude Haiku to determine the right topic (existing or new), and writes/updates a structured Outline document for that topic.
3. The Outline document follows a fixed structure with semantically-merged "high" sections (auto-curated by AI) and an append-only chronological log (raw thread + permalink, never modified by AI).
4. The bot replies in the Mattermost thread with a confirmation and link to the Outline document.

### Non-goals (out of scope for MVP)

- Wiki chat / RAG querying (planned as future phase)
- Bulk historical ingestion of past channel messages
- Multi-tenant SaaS deployment (single-instance for now)
- Web UI for bot configuration (Outline is the UI)

### Tech stack

- **Runtime**: Node.js 20+ with TypeScript (strict mode)
- **Mattermost client**: `@mattermost/client` (REST + WebSocket)
- **AI**: `@anthropic-ai/sdk` with model `claude-haiku-4-5-20251001`
- **Outline**: REST API via native `fetch` (no SDK needed)
- **Storage**: SQLite via `better-sqlite3`
- **Validation**: `zod` for env vars and Claude JSON output
- **Logging**: `pino` with `pino-pretty` in dev
- **Config**: `dotenv`
- **Deploy**: Docker + docker-compose, restart `always`

---

## 1. Infrastructure setup (Phase -1)

This must be completed before the bot is built.

### 1.1 Outline self-hosted on DigitalOcean

Outline requires:

- PostgreSQL 12+
- Redis
- An S3-compatible object storage (DO Spaces works)
- An OAuth provider for authentication (Outline does NOT support local password auth; you must use Slack, Google, Microsoft, OIDC, or similar)

**Recommended setup**:

- A single DigitalOcean Droplet (Ubuntu 24.04, 2 vCPU / 4GB RAM minimum, $24/month tier works fine for small teams)
- Docker Compose stack with: Outline + Postgres + Redis
- DigitalOcean Spaces bucket for file storage (cheaper than self-hosting MinIO)
- Caddy or Nginx as reverse proxy with automatic HTTPS via Let's Encrypt
- A subdomain like `wiki.scalingparrots.com` pointing to the droplet

**OAuth provider**: easiest options for a small team are Google Workspace (if the team has it) or generic OIDC. Document this choice and configure it in Outline's env vars (`GOOGLE_CLIENT_ID` etc., or `OIDC_*` vars).

**Reference docker-compose for Outline** (the agent should adapt this):

```yaml
version: "3"
services:
  outline:
    image: docker.getoutline.com/outlinewiki/outline:latest
    env_file: ./outline.env
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
    restart: always

  redis:
    image: redis:7-alpine
    restart: always
    volumes:
      - ./redis-data:/data

  postgres:
    image: postgres:15-alpine
    env_file: ./postgres.env
    restart: always
    volumes:
      - ./pg-data:/var/lib/postgresql/data
```

**Required Outline env vars** (non-exhaustive, see official docs at https://docs.getoutline.com/s/hosting/doc/docker-7pfeLP5a8t):

- `SECRET_KEY` (generate with `openssl rand -hex 32`)
- `UTILS_SECRET` (generate with `openssl rand -hex 32`)
- `DATABASE_URL`
- `REDIS_URL`
- `URL` (public URL, e.g. `https://wiki.scalingparrots.com`)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_UPLOAD_BUCKET_URL`, `AWS_S3_UPLOAD_BUCKET_NAME` (DO Spaces credentials)
- `FILE_STORAGE=s3`
- OAuth provider credentials (one of `GOOGLE_CLIENT_ID/SECRET`, `OIDC_*`, etc.)
- `FORCE_HTTPS=true`

**Acceptance criteria for Phase -1**:

- Outline accessible via HTTPS on the chosen subdomain
- A user can sign in via the chosen OAuth provider
- The user can manually create a test collection and a test document
- An API token can be generated from the user account at `/settings/tokens`

### 1.2 Mattermost bot account

Create a dedicated bot account in Mattermost (System Console → Integrations → Bot Accounts → Add Bot Account):

- Username: `knowledge-bot` (or similar)
- Display name: `Knowledge Bot`
- Description: `Captures threads and builds the project wiki on Outline`
- Generate and securely store the bot's **personal access token**

The bot account will be invited to channels by users; the bot does not need to auto-discover channels.

**Acceptance criteria**:

- Bot account exists
- Bot token is saved in a secret store (1Password, env, etc.)
- The bot account can be `@mentioned` from a test channel after being invited

### 1.3 Anthropic API key

Provision an Anthropic API key at https://console.anthropic.com.

Set spending limits on the workspace appropriate to expected volume. Haiku 4.5 is cheap; expect <$5/month for small team usage.

---

## 2. Repository structure

```
mattermost-knowledge-bot/
├── .env.example
├── .gitignore
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE                          # MIT, since open-sourcing is planned
├── src/
│   ├── index.ts                     # Entry point
│   ├── config.ts                    # Env vars validation
│   ├── logger.ts                    # Pino setup
│   ├── db/
│   │   ├── index.ts                 # SQLite connection + migrations
│   │   ├── migrations/
│   │   │   └── 001_initial.sql
│   │   └── repositories/
│   │       ├── channels.ts
│   │       ├── topics.ts
│   │       ├── saves.ts
│   │       └── pendingConfirmations.ts
│   ├── mattermost/
│   │   ├── client.ts                # REST client wrapper
│   │   ├── websocket.ts             # WS connection + event dispatcher
│   │   ├── handlers/
│   │   │   ├── userAdded.ts         # Bot added to channel
│   │   │   ├── posted.ts            # New message posted
│   │   │   └── reactionAdded.ts     # Reaction (for confirmations)
│   │   └── helpers.ts               # Thread fetch, mention parsing, permalink building
│   ├── outline/
│   │   ├── client.ts                # REST client wrapper
│   │   ├── collections.ts           # Collection CRUD
│   │   ├── documents.ts             # Document CRUD + structured update
│   │   └── attachments.ts           # File upload
│   ├── ai/
│   │   ├── client.ts                # Anthropic SDK wrapper
│   │   ├── topicDetection.ts        # Prompt 1
│   │   ├── sectionMerge.ts          # Prompt 2
│   │   └── schemas.ts               # Zod schemas for AI outputs
│   ├── core/
│   │   ├── saveFlow.ts              # Orchestrates a save end-to-end
│   │   ├── confirmationFlow.ts      # Handles pending confirmations
│   │   ├── documentBuilder.ts       # Builds final markdown from structured sections + log
│   │   └── commandParser.ts         # Parses @kb commands
│   └── utils/
│       ├── slugify.ts
│       ├── retry.ts
│       └── markdown.ts
├── tests/
│   └── ...                          # Unit tests for documentBuilder, commandParser, slugify
└── data/                            # Mounted volume for SQLite (gitignored)
    └── kb-bot.db
```

---

## 3. Database schema (SQLite)

File: `src/db/migrations/001_initial.sql`

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE channels (
  mm_channel_id          TEXT PRIMARY KEY,
  mm_channel_name        TEXT NOT NULL,
  outline_collection_id  TEXT NOT NULL UNIQUE,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id     TEXT NOT NULL
);

CREATE TABLE topics (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id          TEXT NOT NULL REFERENCES channels(mm_channel_id) ON DELETE CASCADE,
  topic_slug             TEXT NOT NULL,
  topic_display_name     TEXT NOT NULL,
  outline_document_id    TEXT NOT NULL UNIQUE,
  summary                TEXT,                   -- short summary for topic detection prompt
  last_indexed_at        TEXT,                   -- reserved for future RAG embeddings
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mm_channel_id, topic_slug)
);

CREATE INDEX idx_topics_channel ON topics(mm_channel_id);

CREATE TABLE saves (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id            TEXT NOT NULL,
  mm_post_id               TEXT NOT NULL UNIQUE,   -- the post that triggered the save (idempotency)
  mm_root_post_id          TEXT NOT NULL,          -- the root of the thread
  topic_id                 INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  triggered_by_user_id     TEXT NOT NULL,
  triggered_by_username    TEXT NOT NULL,
  outline_revision_before  TEXT,                   -- Outline revision id pre-update
  outline_revision_after   TEXT,                   -- post-update
  status                   TEXT NOT NULL CHECK (status IN ('success','failed','pending_confirmation','cancelled')),
  error_message            TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json             TEXT NOT NULL           -- raw thread snapshot (full posts JSON)
);

CREATE INDEX idx_saves_channel ON saves(mm_channel_id);
CREATE INDEX idx_saves_status ON saves(status);

CREATE TABLE pending_confirmations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id         TEXT NOT NULL,
  mm_thread_root_id     TEXT NOT NULL,
  mm_trigger_post_id    TEXT NOT NULL UNIQUE,
  bot_reply_post_id     TEXT NOT NULL,
  triggered_by_user_id  TEXT NOT NULL,
  proposed_topic_slug   TEXT NOT NULL,
  proposed_topic_name   TEXT NOT NULL,
  alternative_topics    TEXT,                       -- JSON array of alternatives
  payload_json          TEXT NOT NULL,              -- thread snapshot to use when confirmed
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pending_thread ON pending_confirmations(mm_thread_root_id);
CREATE INDEX idx_pending_bot_reply ON pending_confirmations(bot_reply_post_id);
```

---

## 4. Environment variables

File: `.env.example`

```bash
# Mattermost
MM_URL=https://mattermost.scalingparrots.com
MM_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxx
MM_BOT_USER_ID=                 # filled at first boot via /users/me, or set manually
MM_BOT_USERNAME=knowledge-bot

# Outline
OUTLINE_URL=https://wiki.scalingparrots.com
OUTLINE_API_TOKEN=ol_api_xxxxxxxxxxxxxxxxxxxx

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Bot behavior
BOT_TRIGGER_MENTIONS=kb,knowledge-bot       # comma-separated list of mention triggers
CONFIRMATION_CONFIDENCE_THRESHOLD=0.85
CONFIRMATION_TTL_MINUTES=10

# Storage
DB_PATH=/app/data/kb-bot.db

# Logging
LOG_LEVEL=info                  # debug | info | warn | error
NODE_ENV=production
```

---

## 5. Outline document structure (Spec)

Every topic document follows this exact markdown structure. The bot generates and updates it; humans can edit too (Outline keeps history).

```markdown
# {Topic Display Name}

> Auto-curated knowledge document. Last AI update: {ISO timestamp}

## Summary
{3-5 sentence concise overview of the topic, regenerated on each save}

## Decisions
- {date}: {decision text}
- {date}: {decision text}

## Technical details
{specifications, API contracts, configurations, code snippets in fenced blocks, structured as needed}

## Operational notes
{processes, workflows, gotchas, runbooks}

## References
- {link to external doc, repo, other topic}

---

## Chronological log
*Append-only. Never modified by AI.*

### {ISO timestamp} — Saved by @{username}
[View original thread]({mattermost permalink})

> {raw thread content, all messages quoted with author and timestamp}

---

### {ISO timestamp} — Saved by @{username}
...
```

### Key invariants

- The "Chronological log" section is **never** sent to Claude for merge operations. Only sections above the `---` separator are sent. This keeps the context window bounded.
- Empty sections are kept with a placeholder `_(empty)_` rather than removed, so the structure is stable.
- `documentBuilder.ts` is the **single** place that assembles the final markdown. AI returns structured JSON, code assembles markdown.

---

## 6. AI prompts

### 6.1 Prompt 1 — Topic detection

**Model**: `claude-haiku-4-5-20251001`
**Max tokens**: 800
**Temperature**: 0.2

**System prompt**:

```
You are a knowledge management assistant for a software development team.
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
  with confidence 1.0.
```

**User prompt template**:

```
PROJECT (Mattermost channel): {channel_name}

USER COMMAND: {raw_command_text}
EXPLICIT TOPIC HASHTAG (if any): {hashtag_or_none}

EXISTING TOPICS IN THIS PROJECT:
{for each topic:}
- slug: {topic_slug}
  name: {topic_display_name}
  summary: {summary_or_no_summary}

THREAD CONTENT (chronological, oldest first):
{for each message:}
[{timestamp}] @{username}: {message_text}

Decide the topic for this thread.
```

### 6.2 Prompt 2 — Section merge

**Model**: `claude-haiku-4-5-20251001`
**Max tokens**: 4000
**Temperature**: 0.3

**System prompt**:

```
You are a technical writer maintaining a structured knowledge base for a
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
- "change_summary" is a single sentence describing the net change, used in
  Mattermost reply and audit logs.
```

**User prompt template**:

```
TODAY: {YYYY-MM-DD}
TOPIC: {topic_display_name}

EXISTING SECTIONS (current state of the document; sections may be empty):

### Summary
{existing_summary_or_empty}

### Decisions
{existing_decisions_or_empty}

### Technical details
{existing_technical_details_or_empty}

### Operational notes
{existing_operational_notes_or_empty}

### References
{existing_references_or_empty}

NEW THREAD TO INTEGRATE (chronological):
{for each message:}
[{timestamp}] @{username}: {message_text}

Produce the updated sections.
```

### 6.3 Zod schemas

File: `src/ai/schemas.ts`

```typescript
import { z } from "zod";

export const TopicDetectionSchema = z.object({
  decision: z.enum(["match_existing", "create_new"]),
  topic_slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  topic_display_name: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({
    topic_slug: z.string(),
    topic_display_name: z.string(),
    reason: z.string(),
  })).default([]),
  reasoning: z.string(),
});

export const SectionMergeSchema = z.object({
  summary: z.string().nullable(),
  decisions: z.string().nullable(),
  technical_details: z.string().nullable(),
  operational_notes: z.string().nullable(),
  references: z.string().nullable(),
  change_summary: z.string(),
});

export type TopicDetection = z.infer<typeof TopicDetectionSchema>;
export type SectionMerge = z.infer<typeof SectionMergeSchema>;
```

---

## 7. Core flows

### 7.1 Bot added to channel

**Trigger**: WebSocket event `user_added` where `user_id == BOT_USER_ID`.

**Steps**:

1. Fetch channel info: `GET /api/v4/channels/{channel_id}`.
2. Check if the channel already exists in `channels` table. If yes, post a message "Already configured, knowledge base is here: {outline_url}" and stop.
3. Create Outline collection: `POST /collections.create` with `name = channel.display_name`, `description = "Knowledge base for #{channel.name}"`, `permission = "read"` (so all Outline users can read; only API can write).
4. Insert row in `channels` table.
5. Post a welcome message in the channel:

```
👋 Hi! I'm the Knowledge Bot. I just created a wiki collection for this channel: {outline_url}

To save knowledge from a discussion, **reply to a thread** and tag me:
• `@knowledge-bot` — I'll auto-detect the topic
• `@knowledge-bot #topic-name` — to specify the topic explicitly
• `@knowledge-bot help` — show all commands
```

### 7.2 Save flow (mention in thread reply)

**Trigger**: WebSocket event `posted` where:

- The post mentions the bot (check `props.mentions` or text match against trigger names).
- The post has a non-empty `root_id` (i.e. it's a reply in a thread).
- The post is NOT from the bot itself.
- The channel is registered in `channels` table.

**Steps**:

1. Parse the command from the post text. Extract: `subcommand` (save | help | status), `explicit_hashtag` (if any).
2. Idempotency check: query `saves` table for `mm_post_id = post.id`. If exists, ignore.
3. If subcommand is `help` or `status`, handle and return.
4. Default subcommand is `save`. Continue:
5. Fetch the thread: `GET /api/v4/posts/{root_id}/thread`. Extract all posts ordered by `create_at`.
6. Resolve usernames for all `user_id`s in the thread (batch via `POST /users/ids` or cache).
7. Build the thread snapshot: array of `{ timestamp, username, message, file_ids[] }`.
8. Load existing topics for the channel from DB: `SELECT topic_slug, topic_display_name, summary FROM topics WHERE mm_channel_id = ?`.
9. Call **topic detection** prompt → `TopicDetection` JSON.
10. Decide based on result:
    - If `explicit_hashtag` was given → confidence is 1.0 by definition; skip confirmation.
    - If `confidence >= CONFIRMATION_CONFIDENCE_THRESHOLD` → proceed to step 11.
    - Else → enter **confirmation flow** (see 7.3) and stop.
11. Resolve target document:
    - If `decision == "match_existing"`: fetch existing topic from DB, get `outline_document_id`. Fetch current document content from Outline (`POST /documents.info`). Parse out the high sections (everything before the `---` chronological log separator).
    - If `decision == "create_new"`: create Outline document via `POST /documents.create` with empty initial structure (just the title and empty sections); insert topic in DB.
12. Call **section merge** prompt with existing high-sections + new thread → `SectionMerge` JSON.
13. Apply merge: for each non-null returned field, replace the corresponding section. For null fields, keep existing.
14. Append new entry to chronological log (code, not AI):
    - Header: `### {ISO timestamp} — Saved by @{triggering_username}`
    - Permalink line: `[View original thread]({mattermost_permalink})`
    - Quoted thread: each message rendered as `> [{ts}] @{user}: {text}` with file attachments noted.
15. Handle attachments:
    - For each `file_id` across all thread messages, download from Mattermost (`GET /api/v4/files/{file_id}`).
    - Upload to Outline (`POST /attachments.create` returns a public-ish URL).
    - Replace the file reference in the chronological log with a markdown image/link.
16. Build the full document markdown via `documentBuilder.ts`.
17. Update Outline: `POST /documents.update` with the new full text. Capture `revision` before/after.
18. Update DB: bump `topics.last_updated_at`, update `topics.summary` if `SectionMerge.summary` was non-null.
19. Insert `saves` row with status `success`.
20. Reply in Mattermost thread:

```
✅ Saved to **{topic_display_name}** in [{collection_name}]({outline_doc_url})
_{change_summary}_
```

**Error handling**: any exception → `saves` row with status `failed`, error message stored, reply in thread:

```
⚠️ Sorry, something went wrong saving this thread: {short error}. Try again, or check the bot logs.
```

### 7.3 Confirmation flow

When topic detection has low confidence:

1. Build a confirmation message and post it as a reply in the same thread:

```
🤔 I think this belongs in **{proposed_topic_name}**, but I'm not 100% sure.

React with 👍 to confirm, or reply with `#topic-name` to specify a different topic.

Other possibilities I considered:
• {alternative 1}
• {alternative 2}

(I'll forget about this if not confirmed within {TTL_MINUTES} minutes.)
```

2. Insert a row in `pending_confirmations` with the bot's reply post id, the proposed topic, alternatives, and the thread payload.
3. Insert a `saves` row with status `pending_confirmation`.

**Resolution paths**:

**Path A — User reacts with 👍 to bot's confirmation message**:

- WebSocket event `reaction_added` with `post_id == bot_reply_post_id` and `emoji_name == "+1"` (or `thumbsup`).
- Look up `pending_confirmations` by `bot_reply_post_id`.
- Resume save flow at step 11 of 7.2 using the proposed topic.
- Delete `pending_confirmations` row.
- Update `saves` status to `success`.

**Path B — User replies in thread with `#topic-name`**:

- WebSocket event `posted` with `root_id == thread_root_id` and text starting with `#`.
- Look up `pending_confirmations` by `mm_thread_root_id` (most recent unexpired).
- Use the user-specified hashtag as the topic, resume save flow.

**Path C — TTL expires**:

- Periodic cleanup job (every 5 min) deletes `pending_confirmations` where `expires_at < now`.
- The corresponding `saves` row stays with status `pending_confirmation` (or moves to `cancelled`).
- No notification to the user (avoid noise).

### 7.4 Help / status commands

`@knowledge-bot help`:

```
**Knowledge Bot commands:**
• `@knowledge-bot` (in a thread reply) — save the thread, auto-detect topic
• `@knowledge-bot #topic-name` — save with explicit topic
• `@knowledge-bot status` — show this channel's wiki info
• `@knowledge-bot help` — show this message

Documents are stored in Outline: {outline_url}
```

`@knowledge-bot status`:

```
📚 **{channel_name}** wiki status
Collection: [{collection_name}]({collection_url})
Topics: {N}
Last save: {timestamp} by @{user} → {topic}
```

---

## 8. Mattermost integration details

### 8.1 WebSocket connection

Endpoint: `wss://{MM_URL}/api/v4/websocket`. Auth via `authentication_challenge` message after connect:

```json
{ "seq": 1, "action": "authentication_challenge", "data": { "token": "{BOT_TOKEN}" } }
```

Then listen for events. Relevant event types:

- `posted`: new post created. `data.post` is a JSON-stringified post object.
- `reaction_added`: someone reacted. `data.reaction` is JSON-stringified.
- `user_added`: someone added to a channel. Check `data.user_id` and `data.team_id`.
- `hello`: connection established.

**Reconnection logic**: exponential backoff starting at 1s, max 60s. Reset on successful `hello`.

**Heartbeat**: send a `ping` action every 30s; if no reply within 10s, force reconnect.

### 8.2 Thread fetch

`GET /api/v4/posts/{post_id}/thread` returns `{ order: [...post_ids], posts: { post_id: post_object } }`. Sort `order` by `posts[id].create_at`.

### 8.3 Permalink construction

Mattermost permalink format: `{MM_URL}/{team_name}/pl/{post_id}`.

To get the team name, cache team info on first boot via `GET /api/v4/teams`.

### 8.4 Mention detection

A post mentions the bot if either:

- `post.props.mentions` is a JSON array containing `BOT_USER_ID`, OR
- The post text contains `@{trigger_name}` for any trigger in `BOT_TRIGGER_MENTIONS`, where the mention is followed by whitespace, end-of-string, or punctuation.

Use a regex like `/(^|\s)@(kb|knowledge-bot)\b/i`.

### 8.5 Reply in thread

`POST /api/v4/posts` with body `{ channel_id, message, root_id }`. Always set `root_id` to the thread root (not the post that mentioned the bot).

---

## 9. Outline integration details

Base URL: `{OUTLINE_URL}/api`. All endpoints are POST, with JSON body, auth via `Authorization: Bearer {OUTLINE_API_TOKEN}`. Reference: https://www.getoutline.com/developers.

**Endpoints used**:

- `POST /collections.create` — body: `{ name, description, permission: "read" }`
- `POST /documents.create` — body: `{ collectionId, title, text, publish: true }`
- `POST /documents.info` — body: `{ id }` returns full document including `text` and `revision`
- `POST /documents.update` — body: `{ id, text, append: false }` (full replace)
- `POST /attachments.create` — multipart: `name`, `contentType`, `size`, then upload to returned signed URL
- `POST /collections.documents` — body: `{ id }` returns documents in collection (for sync/recovery)

**Error handling**: on 429 or 5xx, retry with exponential backoff (1s, 2s, 4s, 8s, max 4 attempts). On 401, log fatal and stop the worker (token problem).

---

## 10. Anthropic SDK usage

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { TopicDetectionSchema, SectionMergeSchema } from "./schemas";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function detectTopic(input: TopicDetectionInput): Promise<TopicDetection> {
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL!,
    max_tokens: 800,
    temperature: 0.2,
    system: TOPIC_DETECTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildTopicDetectionUserPrompt(input) }],
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }

  const cleaned = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(cleaned);
  return TopicDetectionSchema.parse(parsed);
}
```

**On parse failure**: retry once with a "your previous response was not valid JSON, please retry" follow-up message. If second attempt also fails, error out the save.

---

## 11. Development phases & acceptance criteria

### Phase 0 — Setup (target: 0.5 day)

- Initialize repo, package.json, tsconfig (strict), eslint, prettier
- Dockerfile (multi-stage: build → slim runtime)
- docker-compose.yml mounting `./data` for SQLite persistence
- `src/config.ts` with Zod env validation that fails fast at boot
- `src/logger.ts` with Pino
- `src/db/index.ts` with migration runner
- README with quickstart

**Acceptance**: `docker compose up` starts the container, env vars are validated, DB migrations run, logger emits a "started" line, container stays alive.

### Phase 1 — Mattermost skeleton (target: 1 day)

- WebSocket connection with auth, reconnect, heartbeat
- Event dispatcher: routes `posted`, `reaction_added`, `user_added` to handlers
- Mention parser
- REST client wrapper (with retry)
- Thread fetcher
- Reply-in-thread helper

**Acceptance**: bot connects to Mattermost, when invited to a channel logs "added to channel X", when mentioned in a thread logs the thread content and replies "I see you 👀".

### Phase 2 — Outline integration (target: 1 day)

- REST client with bearer auth and retry
- Collection create on `user_added`
- Document create with empty structure on first save (no AI yet — use a hardcoded topic name "test-topic")
- Document update with new chronological log entry (no AI merge — sections stay empty)
- DB persistence in `channels` and `topics`

**Acceptance**: when bot is added to a channel, an Outline collection appears. When bot is mentioned in a thread, a document is created/updated with the raw thread in the chronological log.

### Phase 3 — AI topic detection + confirmation flow (target: 1 day)

- Anthropic SDK wrapper
- Topic detection prompt with Zod validation and JSON retry
- Confirmation flow with reaction listener and hashtag-reply listener
- TTL cleanup job

**Acceptance**: ambiguous threads trigger a confirmation message; reacting 👍 resumes the save; replying `#foo` overrides the topic.

### Phase 4 — AI section merge (target: 1.5 days)

- Section merge prompt with Zod validation
- documentBuilder.ts to assemble final markdown
- Updating existing topics (multiple saves to same topic)
- `topics.summary` updated when AI returns a new summary

**Acceptance**: saving multiple threads to the same topic produces a clean, consolidated document with structured sections plus full chronological log. Re-saving with new info updates only relevant sections.

### Phase 5 — Attachments (target: 0.5 day)

- Download files from Mattermost
- Upload to Outline
- Inline references in chronological log

**Acceptance**: a thread containing an image is saved with the image visible in the Outline document.

### Phase 6 — Polish & deploy (target: 0.5 day)

- `help` and `status` commands
- Error messages user-friendly
- Documented runbook in README
- Production docker-compose with restart policy and log rotation
- Deploy on Daniel's machine

**Acceptance**: bot runs unattended for 48h with no manual intervention. All saves are logged. README explains how to add to a channel, save, troubleshoot.

**Total estimated effort**: ~6 dev-days for the bot, plus ~1 day for Outline infrastructure setup.

---

## 12. Testing strategy

**Unit tests** (Jest or Vitest):

- `commandParser.ts`: parses all variations of mentions and hashtags
- `slugify.ts`: edge cases (Italian accents, emoji, length cap)
- `documentBuilder.ts`: assembles markdown correctly given various section states; chronological log is preserved exactly across rebuilds (round-trip safety)
- `markdown.ts` parsing helpers: extracting high sections vs log

**Integration tests** (manual checklist for the agent or QA):

1. Invite bot to fresh channel → collection created
2. Tag bot in thread → document created, save reply received
3. Tag bot in another thread (different topic) → new document created
4. Tag bot in third thread (same topic as #2) → existing document updated
5. Tag bot with explicit `#hashtag` → uses that exact topic
6. Tag bot with ambiguous topic → confirmation message appears; 👍 resolves it
7. Reply with `#different` to confirmation → uses different topic
8. Wait for TTL → confirmation expires silently
9. Restart bot mid-flow → idempotency holds, no duplicate saves
10. Tag bot in thread with image attachment → image appears in Outline

---

## 13. Logging & observability

Every operation logs structured JSON:

```json
{ "level": "info", "msg": "save_completed", "channel_id": "...", "topic_slug": "...", "save_id": 42, "duration_ms": 2840, "ai_tokens_in": 1200, "ai_tokens_out": 380 }
```

Key events to log:

- `bot_started`, `ws_connected`, `ws_reconnecting`
- `channel_added`, `collection_created`
- `save_started`, `topic_detected`, `confirmation_requested`, `confirmation_resolved`, `merge_completed`, `outline_updated`, `save_completed`, `save_failed`
- `attachment_uploaded`

Token usage logging is important because Daniel asked about Haiku cost — having `ai_tokens_in`/`ai_tokens_out` in every save log lets you compute monthly cost easily.

---

## 14. Open-source readiness

Since Daniel plans to open-source this:

- LICENSE: MIT
- README sections: What it does, Architecture diagram (text or mermaid), Prerequisites, Quickstart, Configuration reference, Deployment guide, Contributing, License
- No Scaling Parrots-specific naming in code
- No hardcoded URLs
- `.env.example` complete and commented
- No secrets ever committed (verify `.gitignore`)
- Issue templates for bugs / features
- A short CHANGELOG.md starting with v0.1.0

Suggested repo name: `mattermost-knowledge-bot` or `kb-bot`.

---

## 15. Future phases (not part of this plan, but design-aware)

The agent should NOT implement these now, but the schema and code structure must not block them.

### Phase 7 — Wiki chat / RAG

- Add `embeddings` table: `(topic_id, chunk_idx, chunk_text, embedding BLOB, created_at)`
- On every `success` save, enqueue a re-indexing job: chunk the document, embed via Voyage or OpenAI, store
- New command `@knowledge-bot ask <question>`: retrieve top-k chunks, pass to Claude Sonnet for synthesis, reply in thread
- Optional: a small web UI or Outline integration for chat

### Phase 8 — Consolidation command

- `@knowledge-bot consolidate` (admin only): re-runs section merge across all threads in the chronological log to produce a cleaner version. One-shot reorganization.

### Phase 9 — Multi-channel topics

- Allow multiple channels to feed the same project collection (e.g. `#client-a-frontend` and `#client-a-backend` both write to "Client A" collection).
- Configurable via a `@knowledge-bot init project=ClientA` command.

---

## 16. Deliverables checklist for the executing agent

Once execution is complete, the agent should hand back:

- [ ] Working Outline instance on DigitalOcean (URL + how to log in)
- [ ] Mattermost bot account credentials documented
- [ ] Anthropic API key configured
- [ ] Repository on GitHub (private initially) with all phases merged
- [ ] Docker image built and running on Daniel's machine
- [ ] `.env` file populated on the host (NOT in git)
- [ ] All 10 integration tests from §12 passing
- [ ] README that a new dev can follow to redeploy from scratch
- [ ] First real-world save demonstrated in a Scaling Parrots channel
- [ ] Logs from 24h of running attached to the handover

---

## 17. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Outline OAuth setup blocks team access | Med | High | Pick a provider the whole team already uses (Google Workspace probably). Test with 2 users before bot dev. |
| Mattermost WS disconnects silently | Med | Med | Heartbeat + reconnect logic + alerting on prolonged disconnection |
| Claude returns invalid JSON | Low | Med | Zod validation + 1 retry with corrective prompt + fail-loud |
| Section merge loses information | Med | High | B3 design: chronological log is append-only and never AI-touched, so info is always recoverable. Outline document history is a second safety net. |
| Token costs balloon on long topics | Low | Low | Document log is truncated before sending to AI; only high sections passed. Monitor with logged `ai_tokens_in`. |
| Race conditions on simultaneous saves to same topic | Low | Med | SQLite per-channel mutex around save operations |
| User abuse (spam mentions) | Low | Low | Per-user rate limit (e.g. 10 saves/hour) — implement only if observed |

---

End of plan. The executing agent should start at §1 (infrastructure), then proceed sequentially through §11 phases, validating acceptance criteria at each step.
