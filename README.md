# Mattermost Knowledge Bot

Captures Mattermost thread discussions and progressively builds a structured knowledge wiki in Outline, organized by channel and topic. Uses Claude Haiku for topic detection and section merging.

## Architecture

```
Mattermost  ──WS──▶  bot  ──REST──▶  Outline
                      │
                      └──REST──▶  Anthropic (Claude Haiku)

Storage:  SQLite  ./data/kb-bot.db
```

The bot authenticates to Mattermost via WebSocket, listens for thread replies that mention it, and writes/merges structured Markdown documents into Outline collections (one collection per channel).

## Prerequisites

- Mattermost bot account with a bot token (System Console → Integrations → Bot Accounts). The bot account must be a member of the team(s) whose channels it will serve, otherwise it cannot be invited to channels and permalinks will be malformed.
- Outline instance with an API token (Settings → API tokens). The token's user must have permission to create collections and documents.
- Anthropic API key with access to Claude Haiku 4.5 (or whatever model you set in `ANTHROPIC_MODEL`).
- Node.js 20+ (local dev) or Docker 24+ with Compose v2 (production).

> **Outline collection visibility**: collections created by the bot use `permission: "read"`, meaning every Outline user can read every channel's wiki. If you serve private Mattermost channels with sensitive data, decide whether that visibility model is acceptable for your team before deploying.

## Configuration

Copy `.env.example` to `.env` and fill in all required values.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MM_URL` | yes | — | Mattermost base URL, e.g. `https://chat.example.com` |
| `MM_BOT_TOKEN` | yes | — | Bot account token |
| `MM_BOT_USERNAME` | yes | — | Bot's username (used in help text) |
| `MM_BOT_USER_ID` | no | auto-resolved | Bot's user ID; resolved at startup if blank |
| `OUTLINE_URL` | yes | — | Outline base URL, e.g. `https://wiki.example.com` |
| `OUTLINE_API_TOKEN` | yes | — | Outline API token |
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key |
| `ANTHROPIC_MODEL` | no | `claude-haiku-4-5-20251001` | Model used for topic detection and merging |
| `BOT_TRIGGER_MENTIONS` | no | `wikibot,kb,knowledge-bot` | Comma-separated list of usernames that trigger the bot |
| `CONFIRMATION_CONFIDENCE_THRESHOLD` | no | `0.85` | AI confidence above which saves proceed without confirmation |
| `CONFIRMATION_TTL_MINUTES` | no | `10` | Minutes before an unconfirmed save request expires |
| `CLEANUP_INTERVAL_MINUTES` | no | `5` | How often expired pending confirmations are cleaned up |
| `DB_PATH` | no | `./data/kb-bot.db` | SQLite database path |
| `LOG_LEVEL` | no | `info` | One of: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | no | `production` | `development`, `production`, or `test` |

## Local development

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev        # hot-reloads via tsx watch
npm test           # run unit tests
npm run typecheck  # TypeScript strict check
```

## Production deployment

```bash
git clone https://github.com/danyeah/mattermost-knowledge-bot /opt/kb-bot
cd /opt/kb-bot
cp .env.example .env
# populate MM_BOT_TOKEN, OUTLINE_API_TOKEN, ANTHROPIC_API_KEY in .env

# the container runs as UID 1000; chown the host volume so SQLite can write
mkdir -p data && chown -R 1000:1000 data

docker compose up -d --build
docker compose logs -f
```

Healthy startup logs (in order):
```
db_ready
primary_team_resolved
confirmation_cleanup_started
ws_connected
ws_authenticated
```

Logs are written via the `json-file` driver, rotated at 10 MB, kept for 5 files.
Container data (SQLite) is mounted at `./data` on the host.

To stop: `docker compose down`
To update: `git pull && docker compose up -d --build`

### Co-locating with an existing Mattermost / Postgres host

The bot uses `network_mode: host` so it reaches `localhost` services on the droplet directly. If you also self-host Outline next to Mattermost on the same machine, you can share Postgres between them: create a dedicated DB (`outline`) and user, point Outline's `DATABASE_URL` at `127.0.0.1:5432`, and the bot will sit alongside both as a third service. There's no DB conflict between the bot and Mattermost — the bot uses SQLite locally for its own state.

## How to use

1. **Invite the bot** to a channel via System Console → Channels → Members (or `/invite @<bot-username>`). The bot auto-creates an Outline collection for the channel on first save.

2. **Save a thread**: in any thread reply, mention the bot:
   ```
   @knowledge-bot
   ```
   The bot detects the topic automatically. If confidence is below `CONFIRMATION_CONFIDENCE_THRESHOLD` (default 0.85), the bot replies with a confirmation message listing the proposed topic and a couple of alternatives. React with 👍 to accept, or reply with `#different-topic` to override. Confirmations expire after `CONFIRMATION_TTL_MINUTES` (default 10).

3. **Explicit topic**: add a `#topic-name` hashtag to override AI detection:
   ```
   @knowledge-bot #authentication
   ```

4. **Confirm a pending save**: react with 👍 to the bot's confirmation message, or reply with `#new-topic` to change the topic.

5. **Help**:
   ```
   @knowledge-bot help
   ```

6. **Channel wiki status**:
   ```
   @knowledge-bot status
   ```

## Troubleshooting

**Bot doesn't respond to mentions**
Check that the WS connection succeeded. Logs should contain `ws_authenticated` shortly after startup. If missing, verify `MM_URL` and `MM_BOT_TOKEN`.

**"This channel isn't configured" error**
The bot must be a member of the channel. Invite it via System Console or Mattermost's `/invite` command.

**AI errors / topic detection failing**
Check `ANTHROPIC_API_KEY` is valid and the configured `ANTHROPIC_MODEL` is available on your account. Logs will contain the raw error from the Anthropic API.

**Outline auth errors**
Verify `OUTLINE_API_TOKEN` is valid and not expired. The token needs permission to create and update documents in your Outline instance.

**Database issues**
The SQLite file is at `DB_PATH` (default `./data/kb-bot.db`). Ensure the directory is writable by UID 1000 (the container's `node` user): `chown -R 1000:1000 data` on the host. A common first-boot symptom is `SQLITE_CANTOPEN` in the logs — fix the host directory ownership and `docker compose restart bot`.

**Bot saved a save into a topic that doesn't make sense**
Topic detection runs on the thread you mentioned the bot in. If you want explicit control, use `@bot #my-topic` in the same reply. To rename or merge topics, edit them directly in Outline; the bot tracks them by `outline_document_id`, so renaming the document title in Outline is safe (the bot still finds the right topic).

## Testing

```bash
npm test
```

Runs unit tests via vitest (no network calls, no `.env` required):
- `commandParser.test.ts` — command parsing variants
- `slugify.test.ts` — slug generation edge cases
- `documentBuilder.test.ts` — Markdown assembly and round-trip parsing
- `helpers.test.ts` — mention parsing, hashtag extraction, permalink building

## License

MIT
