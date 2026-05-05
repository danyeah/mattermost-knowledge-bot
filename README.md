# Mattermost Knowledge Bot

Captures Mattermost discussion threads and progressively builds a structured knowledge wiki on Outline, organized per channel/topic, using Claude Haiku for topic detection and section merging.

## Status

Work in progress. Phase 0 (skeleton) complete. See `IMPLEMENTATION_PLAN.md` for the roadmap.

## Architecture

```
Mattermost  ──WS──▶  bot  ──REST──▶  Outline
                     │
                     └──REST──▶  Anthropic (Haiku)

Storage:  SQLite (./data/kb-bot.db)
Host:     DigitalOcean droplet co-located with Mattermost + Outline
```

## Quickstart (local dev)

Requirements: Node 20+, sqlite, Docker (optional).

```bash
cp .env.example .env       # then fill in tokens
npm install
npm run dev
```

## Deploy (production droplet)

```bash
# on the droplet
git clone <repo> /opt/kb-bot && cd /opt/kb-bot
cp .env.example .env       # populate MM_BOT_TOKEN, OUTLINE_API_TOKEN, ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f
```

## License

MIT
