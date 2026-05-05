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

- Mattermost bot account with a bot token (System Console → Integrations → Bot Accounts)
- Outline instance with an API token (Settings → API tokens) and at least one collection writable by the token
- Anthropic API key with access to Claude Haiku
- Node.js 20+ (local dev) or Docker with Compose v2 (production)

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

docker compose up -d --build
docker compose logs -f
```

Logs are written via the `json-file` driver, rotated at 10 MB, kept for 5 files.
Container data (SQLite) is mounted at `./data` on the host.

To stop: `docker compose down`
To update: `git pull && docker compose up -d --build`

## How to use

1. **Invite the bot** to a channel via System Console → Channels → Members (or `/invite @<bot-username>`). The bot auto-creates an Outline collection for the channel on first save.

2. **Save a thread**: in any thread reply, mention the bot:
   ```
   @knowledge-bot
   ```
   The bot detects the topic automatically. If confidence is below the threshold, it asks you to confirm.

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
The SQLite file is at `DB_PATH` (default `./data/kb-bot.db`). Ensure the directory is writable. In Docker, the `./data` volume must be mounted.

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
