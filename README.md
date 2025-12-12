# Telegram Card Game Bot (Node.js / Telegraf + Postgres)

This project is a ready-to-deploy Node.js Telegram bot implementing the card game mechanics you requested.

## Features
- Free pack every 30 minutes (5 cards)
- Shop (packs x2 / x3 / x10)
- Inventory with cards and images (saved as Telegram file_id)
- Trades between players (create request, accept/reject)
- Admin panel inside bot: add cards by sending photo with caption `Name | rarity | coins_per_hour` and list cards
- Passive income: coins per hour from cards, distributed every hour

## Files
- `index.js` - main bot code (Telegraf)
- `package.json` - Node dependencies
- `Procfile` - start command for Render (web)
- `render.yaml` - Render service definition (optional)
- `sql/schema.sql` - SQL schema to inspect or run locally
- `README.md` - this file

## Environment variables (set in Render)
- `BOT_TOKEN` - token from BotFather
- `DATABASE_URL` - Postgres connection string (use Render Managed Postgres or external)
- `ADMIN_IDS` - comma-separated admin Telegram IDs (e.g. 123456789)
- `COOLDOWN_MINUTES` - optional, default 30

## Deploy on Render (summary)
1. Push this repo to GitHub.
2. Create a new **Web Service** on Render and connect repo.
3. Choose Environment: **Node** (Render will use package.json)
4. Start Command: `node index.js` (render.yaml already has it)
5. Add Environment Variables (BOT_TOKEN, DATABASE_URL, ADMIN_IDS)
6. Deploy. The service uses long-polling and runs on free plan.

## Database
The bot auto-creates tables if they do not exist (see `sql/schema.sql`). If you prefer, create DB manually using that SQL.

## Notes
- Images are stored as Telegram `file_id` strings; they are not uploaded to external storage.
- For reliability, ensure `DATABASE_URL` uses a managed Postgres accessible by Render.
- On free tier, Render may restart your instance — Telegraf will reconnect on next start.
