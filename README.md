# Family Budget

A private, free family budgeting app for two partners and their kids. It answers "Are we OK this week?", keeps each of you a no-questions fun money allowance, tracks what each kid costs, plans paychecks against bills week by week, and walks you through a monthly check-in together.

- **Runs on:** Cloudflare Workers + D1 (free tier), locked to your two emails with Cloudflare Access.
- **Bank data:** Plaid Trial (free, 10 bank logins) with daily sync, or CSV/OFX/QFX file import.
- **Your data:** export to JSON/CSV any time, plus full database backups with `npm run backup`.

See [SETUP.md](SETUP.md) to get it running.

## Layout

```
src/shared   budget math and parsing (pure, unit tested): weeks, paydays, forecast, rules, transfers, imports, debt, goals
src/worker   API (Hono on Cloudflare Workers): auth, routes, Plaid sync, D1 queries
src/client   React app (installable PWA)
migrations   D1 schema and seed categories
tests        Vitest, including a golden month from the original spreadsheet
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local app + API with a local database |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript across client, worker and tests |
| `npm run deploy` | Build, apply new database migrations, and deploy to Cloudflare |
| `npm run db:migrate:local` / `:remote` | Apply database migrations |
| `npm run backup` | Save a full SQL copy of the production database |
