# Monitoring Guide

## Health Endpoints

The bot exposes two HTTP endpoints on `PORT` (default 8080).

### GET /health

Lightweight liveness check used by Railway.

```json
{
  "status": "ok",
  "uptime": 3600,
  "modules": ["latency-sniper", "resolution-arb"],
  "tradingMode": "paper"
}
```

### GET /status

Extended status with trade and error counters.

```json
{
  "status": "ok",
  "uptime": 3600,
  "startedAt": "2024-01-15T12:00:00.000Z",
  "tradingMode": "paper",
  "activeModules": ["latency-sniper", "resolution-arb"],
  "disabledModules": ["cross-market-arb", "market-making"],
  "tradesExecuted": 12,
  "opportunitiesFound": 47,
  "errors": 0,
  "circuitBreakerActive": false
}
```

---

## Logs

All logs are structured JSON — one object per line — suitable for Railway's log drain or any JSON log aggregator.

### Log format

```json
{
  "ts": "2024-01-15T12:00:00.000Z",
  "level": "INFO",
  "module": "latency-sniper",
  "msg": "Opportunity detected",
  "edge": 0.15,
  "confidence": 82
}
```

### Log levels

| Level | When |
|---|---|
| `DEBUG` | Verbose internals (suppressed in `NODE_ENV=production`) |
| `INFO` | Normal operation events |
| `WARN` | Non-fatal issues (Supabase offline, no matching market) |
| `ERROR` | Failures that affect trading |

### Key log messages to watch

| Message | Module | Action |
|---|---|---|
| `Module crashed — restarting in 30s` | main | Check error field; module will auto-restart |
| `Circuit breaker activated` | risk-manager | Bot paused — check daily P&L |
| `Daily loss limit reached` | risk-manager | Trading halted for the day |
| `CLOB order rejected` | trade-executor | Check CLOB API credentials / wallet balance |
| `Supabase connection failed` | main | Persistence offline; bot continues in memory |
| `No modules enabled` | main | All `ENABLE_*` vars are false |

---

## Railway Log Streaming

```bash
# Stream live logs
railway logs --follow

# Search for errors
railway logs | grep '"level":"ERROR"'

# Search for trades
railway logs | grep '"msg":"Trade executed"'
```

---

## Supabase Dashboards

### Trades table

```sql
-- Recent trades
SELECT module, market_slug, side, amount_usdc, status, executed_at
FROM trades
ORDER BY executed_at DESC
LIMIT 50;

-- Daily P&L summary
SELECT
  DATE(executed_at) AS day,
  COUNT(*) AS trades,
  SUM(realized_profit) AS pnl_usdc
FROM trades
WHERE status = 'filled'
GROUP BY day
ORDER BY day DESC;
```

### Opportunities table

```sql
-- Conversion rate (detected → traded)
SELECT
  status,
  COUNT(*) AS count,
  AVG(edge) AS avg_edge,
  AVG(confidence) AS avg_confidence
FROM opportunities
GROUP BY status;

-- Missed opportunities (edge too low)
SELECT market_slug, edge, confidence, detected_at
FROM opportunities
WHERE status = 'missed'
ORDER BY detected_at DESC
LIMIT 20;
```

### Risk management state

```sql
SELECT module, daily_pnl_usdc, consecutive_losses, circuit_breaker_active, last_updated
FROM risk_management;
```

---

## Alerts

### Recommended alerts to set up in Railway or your logging tool

1. **Error spike**: `errors` counter in `/status` increases by >5 in 5 minutes
2. **Circuit breaker active**: poll `/status` and alert when `circuitBreakerActive: true`
3. **No opportunities**: `opportunitiesFound` hasn't increased in 30 minutes during a live match
4. **Health check failure**: Railway alerts automatically if `/health` returns non-200

### Simple polling script

```bash
#!/bin/bash
STATUS=$(curl -s https://your-app.railway.app/status)
CB=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['circuitBreakerActive'])")

if [ "$CB" = "True" ]; then
  echo "ALERT: Circuit breaker is active!"
  # Send Slack/PagerDuty/email notification
fi
```

---

## Performance Benchmarks

Expected steady-state resource usage on Railway Hobby plan:

| Metric | Expected |
|---|---|
| Memory (RSS) | 80–150 MB |
| CPU | <5% idle, <20% during event processing |
| API-Football calls | ~40–80/day (depends on live match count) |
| Supabase writes | ~5–20/day (opportunities + trades) |

If memory exceeds 300 MB, check for a cache leak in event-detector or market-matcher.

---

## Incident Runbook

### Bot not trading (no trades in 30+ min during live matches)

1. Check `/status` — is `circuitBreakerActive: true`? → Daily loss limit hit; wait until midnight UTC.
2. Check logs for `Module crashed` → Module auto-restarted; check error message.
3. Check `opportunitiesFound` counter — increasing? → Opportunities detected but risk checks blocking; check `DAILY_LOSS_LIMIT_USDC`.
4. Check API-Football quota → Free tier is 100 req/day; may be exhausted.

### High error rate

1. `railway logs | grep ERROR` → Identify error source.
2. CLOB errors → Check wallet USDC balance and API credentials.
3. Supabase errors → Check Supabase project status at status.supabase.com.
4. Network errors → Transient; modules will auto-retry.

### Unexpected live orders

1. Verify `TRADING_MODE=paper` is set correctly.
2. Check Railway Variables — env var may have been overridden.
3. Check Polymarket order history via CLOB API.
