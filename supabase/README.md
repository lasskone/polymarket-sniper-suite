# Supabase Setup

## Applying the Schema

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Navigate to **SQL Editor** (left sidebar)
4. Click **New query**
5. Open `supabase/schema.sql` from this repo and copy the full contents
6. Paste into the SQL Editor and click **Run** (or `Ctrl+Enter`)

The schema is idempotent — safe to re-run. It uses `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, and `CREATE POLICY IF NOT EXISTS` throughout.

## Verify Tables Were Created

Run this in the SQL Editor after applying the schema:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'trades', 'opportunities', 'performance',
    'risk_management', 'market_snapshots'
  )
ORDER BY table_name;
```

Expected result: **5 rows**.

## Environment Variables

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-public-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-secret-key>
```

Find these in: Supabase Dashboard → **Project Settings** → **API**.

> The bot uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses Row Level Security.
> Never expose the service role key client-side.

## Test the Connection

After filling `.env`, run:

```bash
npm run test:supabase
```

This runs `scripts/test-supabase.ts` which initialises the client, queries the
`trades` table, and prints a success or failure message.

## Tables

| Table | Purpose |
|---|---|
| `trades` | Every order placed by any module |
| `opportunities` | Every edge detected (traded or not) |
| `performance` | Daily aggregate stats per module |
| `risk_management` | Daily risk state + circuit breaker log |
| `market_snapshots` | Point-in-time price/liquidity captures |
