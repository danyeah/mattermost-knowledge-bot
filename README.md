# Mattermost Knowledge Bot

A self-hosted AI knowledge assistant that connects Mattermost and Outline wiki. It captures thread discussions into structured wiki documents and enables semantic search over the entire wiki — both from Mattermost chat and via a floating chat widget embedded directly in Outline pages.

All inference runs locally: embeddings via Ollama (bge-m3) and answer generation via a local LLM (tested with Qwen 3 27B on llama.cpp). No data leaves your network.

## Features

- **Save threads to wiki** — mention the bot in any Mattermost thread to save it to Outline, with AI-powered topic detection and section merging
- **Semantic search from chat** — `@wikibot cerca <question>` searches the wiki using RAG and replies with a cited answer
- **Outline chat widget** — a floating chat bubble embedded in Outline pages, context-aware (scopes search to the current document or collection, falls back to full wiki)
- **Local LLM** — drop-in support for any OpenAI-compatible endpoint (llama.cpp, vLLM, etc.) instead of Anthropic
- **Concurrency queue** — single-slot semaphore on LLM calls with live queue-depth feedback to users

## Architecture

```
Mattermost  ──WS──▶  bot  ──REST──▶  Outline
                      │
                      ├──REST──▶  Ollama (bge-m3 embeddings)
                      │
                      ├──REST──▶  LLM (local via llama.cpp / Anthropic fallback)
                      │
                      └──HTTP:3333──▶  Widget API  ◀──  Outline browser widget

Storage: SQLite  ./data/kb-bot.db
  ├── topics          (channel → Outline document mapping)
  ├── document_chunks (chunked wiki content + embeddings)
  ├── index_state     (per-doc revision tracking)
  └── pending_confirmations
```

The bot authenticates to Mattermost via WebSocket, listens for mentions, and writes structured Markdown into Outline. A background job re-indexes all Outline documents on a configurable interval, enabling semantic search.

## Prerequisites

- Mattermost bot account (System Console → Integrations → Bot Accounts). The bot must be a member of the team(s) it serves.
- Outline instance with an API token (Settings → API tokens). The token's user needs permission to create collections and documents.
- **Ollama** running with `bge-m3` pulled (`ollama pull bge-m3`). Used for embeddings.
- **Local LLM** via an OpenAI-compatible endpoint (recommended: llama.cpp with Qwen 3 27B), **or** an Anthropic API key.
- Node.js 20+ (local dev) or Docker 24+ with Compose v2 (production).

> **Outline collection visibility**: collections created by the bot use `permission: "read"` — all Outline users can read every channel's wiki. Adjust if you serve private channels with sensitive data.

## Configuration

Copy `.env.example` to `.env` and fill in required values.

### Core

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MM_URL` | yes | — | Mattermost base URL |
| `MM_BOT_TOKEN` | yes | — | Bot account token |
| `MM_BOT_USERNAME` | yes | — | Bot's username (used in help text) |
| `MM_BOT_USER_ID` | no | auto-resolved | Bot user ID; resolved at startup if blank |
| `OUTLINE_URL` | yes | — | Outline base URL |
| `OUTLINE_API_TOKEN` | yes | — | Outline API token |

### LLM

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_BASE_URL` | no | — | OpenAI-compatible base URL (e.g. `http://localhost:8020`). When set, overrides Anthropic. |
| `LLM_MODEL` | no | `Qwen3.6-27B-UD-Q4_K_XL.gguf` | Model name sent to the OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | no | — | Anthropic API key (used only when `LLM_BASE_URL` is not set) |
| `ANTHROPIC_MODEL` | no | `claude-haiku-4-5-20251001` | Anthropic model |

### Embeddings

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OLLAMA_URL` | no | `http://ollama:11434` | Ollama endpoint for bge-m3 embeddings |
| `INDEX_SYNC_INTERVAL_MINUTES` | no | `60` | How often to re-index all Outline documents |

### Bot behaviour

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TRIGGER_MENTIONS` | no | `wikibot,kb,knowledge-bot` | Comma-separated trigger usernames |
| `CONFIRMATION_CONFIDENCE_THRESHOLD` | no | `0.85` | AI confidence above which saves skip confirmation |
| `CONFIRMATION_TTL_MINUTES` | no | `10` | Minutes before unconfirmed saves expire |
| `CLEANUP_INTERVAL_MINUTES` | no | `5` | Cleanup interval for expired confirmations |

### HTTP API / Widget

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_PORT` | no | `3333` | Port for the widget API server |
| `API_CORS_ORIGIN` | no | `*` | CORS `Access-Control-Allow-Origin` header |

### Storage / Logging

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DB_PATH` | no | `./data/kb-bot.db` | SQLite database path |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |

## Local development

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev        # hot-reload via tsx watch
npm test           # unit tests
npm run typecheck  # TypeScript strict check
```

## Production deployment

```bash
git clone https://github.com/danyeah/mattermost-knowledge-bot /opt/kb-bot
cd /opt/kb-bot
cp .env.example .env
# populate the required vars in .env

mkdir -p data && chown -R 1000:1000 data
docker compose up -d --build
docker compose logs -f
```

Expected startup log sequence:
```
db_ready
primary_team_resolved
api_server_started
confirmation_cleanup_started
embedding_model_ready        (or embedding_model_not_ready_search_disabled)
ws_connected
ws_authenticated
outline_index_sync_start
outline_index_sync_done
```

To update: `git pull && docker compose up -d --build`

### Network topology

The Docker Compose file joins an external `pm-network` and includes an Ollama sidecar. If you run the local LLM on a separate machine (e.g. a GPU server), connect the bot's VPS to it via **Tailscale** and set `LLM_BASE_URL` to the Tailscale IP.

```
[VPS: kb-bot + ollama]  ──Tailscale──▶  [GPU server: llama.cpp :8020]
```

Optionally put **llm-proxy** in front of llama.cpp to get request logging and a monitoring dashboard.

## How to use

### Save a thread to Outline

In any Mattermost thread reply, mention the bot:
```
@wikibot
```
The bot detects the topic automatically. If confidence is below the threshold, it asks for confirmation — react with 👍 or reply with `#different-topic`.

Override topic detection explicitly:
```
@wikibot #authentication
```

### Semantic search from Mattermost

```
@wikibot cerca come funziona il processo di onboarding?
```
The bot searches documents saved for that channel via RAG, generates an answer with Qwen, and replies with cited sources. If no relevant documents are found, it says so.

### Semantic search from Outline (widget)

The widget is a floating chat bubble that appears on every Outline page. Embed it by injecting the script via your Outline reverse proxy:

**nginx** (`sub_filter` + proxy):
```nginx
location /kb/ {
    proxy_pass http://<kb-bot-host>:3333/;
}

sub_filter '</body>' '<script src="/kb/widget.js"></script></body>';
sub_filter_once on;
```

The widget automatically scopes search to the current context:
- On a `/doc/*` page → searches only that document first, falls back to full wiki
- On a `/collection/*` page → searches only that collection first, falls back to full wiki
- On any other page → searches the full wiki

If the LLM is busy, the widget shows "In coda... (N prima di te)" updated every 2 seconds.

### Other commands

```
@wikibot help    # usage instructions
@wikibot status  # channel wiki status and Outline link
```

## RAG pipeline

1. **Indexing** (background, every `INDEX_SYNC_INTERVAL_MINUTES`): fetches all Outline documents, splits into chunks by `##` heading, embeds via bge-m3 (Ollama), stores in SQLite.
2. **Search**: embeds the query, computes cosine similarity against all stored chunks, returns top-K.
3. **Generation**: top-K chunks are passed as context to the LLM, which generates an answer in Italian with source citations.

## Troubleshooting

**Bot doesn't respond**
Check `ws_authenticated` appears in logs. Verify `MM_URL` and `MM_BOT_TOKEN`.

**Search returns no results**
Check `embedding_model_ready` in startup logs. Verify Ollama is running and `bge-m3` is pulled. If `outline_index_sync_done` shows `indexed: 0`, check `OUTLINE_URL` and `OUTLINE_API_TOKEN`.

**LLM errors**
If using local LLM, check `LLM_BASE_URL` is reachable from the bot container. If using Anthropic, verify `ANTHROPIC_API_KEY`.

**Widget returns 404 on `/kb/search`**
Your Outline reverse proxy is not forwarding `/kb/` to the bot. Add the `location /kb/` proxy block shown above.

**Database issues**
Ensure `./data` is writable by UID 1000: `chown -R 1000:1000 data`. A `SQLITE_CANTOPEN` error at startup means the directory permissions are wrong.

**Topic saved to wrong document**
Use `@wikibot #explicit-topic` to override. Renaming the document title in Outline is safe — the bot tracks documents by ID, not title.

## Testing

```bash
npm test
```

Unit tests (no network, no `.env` required):
- `commandParser.test.ts`
- `slugify.test.ts`
- `documentBuilder.test.ts`
- `helpers.test.ts`

## License

MIT
