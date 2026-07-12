# Deployment Guide

## Prerequisites

- Node.js 20+ installed
- A funded Polygon wallet with USDC (for live mode)
- Polymarket CLOB API credentials (derive from private key)
- Supabase project with schema applied (`supabase/schema.sql`)
- API-Football key (free tier: 100 req/day)

---

## Local Development

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your credentials

# Run in dev mode (tsx, no build step)
npm run dev
```

---

## Production Build

```bash
npm run build          # outputs to dist/
npm start              # runs dist/bot/index.js
```

---

## Railway Deployment

### 1. Create a new Railway project

```bash
npm install -g @railway/cli
railway login
railway init
```

### 2. Set environment variables

In the Railway dashboard → Variables, set all keys from `.env.example`:

| Variable | Required | Notes |
|---|---|---|
| `PRIVATE_KEY` | Live only | Polygon wallet private key |
| `WALLET_ADDRESS` | Live only | Matching wallet address |
| `POLYMARKET_API_KEY` | Live only | Derived from private key |
| `POLYMARKET_API_SECRET` | Live only | Derived from private key |
| `POLYMARKET_PASSPHRASE` | Live only | Derived from private key |
| `SUPABASE_URL` | Yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Bypasses RLS |
| `API_FOOTBALL_KEY` | Yes | API-Sports key |
| `TRADING_MODE` | Yes | `paper` or `live` |
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | No | Railway sets this automatically |

### 3. Deploy

```bash
railway up
```

Railway will:
1. Detect the `railway.json` config
2. Build via Nixpacks (installs deps, runs `npm run build`)
3. Start with `node dist/bot/index.js`
4. Health-check `GET /health` before routing traffic

### 4. Verify deployment

```bash
# Check health
curl https://your-app.railway.app/health

# Check full status
curl https://your-app.railway.app/status

# Stream logs
railway logs
```

---

## Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Open the SQL editor and paste the contents of `supabase/schema.sql`
3. Run the schema — all tables, indexes, and RLS policies will be created
4. Copy the **Service Role Key** (Settings → API) — this bypasses RLS for bot writes
5. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your environment

---

## Trading Modes

### Paper Mode (default)
- `TRADING_MODE=paper`
- All trade logic runs but no orders are sent to the CLOB
- Supabase records show `paper: true`
- Safe to run without wallet credentials

### Live Mode
- `TRADING_MODE=live`
- Real FOK orders placed on Polygon mainnet
- Requires `PRIVATE_KEY`, `WALLET_ADDRESS`, and CLOB API credentials
- Start with small position sizes and monitor closely

---

## Module Configuration

Enable/disable modules via environment variables:

```bash
ENABLE_LATENCY_SNIPER=true    # Soccer goal sniping
ENABLE_RESOLUTION_ARB=true    # Resolution arbitrage
ENABLE_CROSS_MARKET_ARB=false # Cross-market arbitrage (not yet implemented)
ENABLE_MARKET_MAKING=false    # Market making (not yet implemented)
```

---

## Rollback

Railway keeps previous deployments. To roll back:

```bash
railway rollback
```

Or redeploy a specific commit:

```bash
git push railway <commit-sha>:main
```
