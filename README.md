# Polymarket Sniper Suite

**Production-grade Polymarket trading bot suite with latency sniping, arbitrage, and resolution modules.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

`polymarket-sniper-suite` is a modular, production-ready bot framework for trading on Polymarket. It extends the base SDK with specialized execution modules designed around real-world alpha strategies: exploiting latency windows on live sports events, capitalizing on resolution delays, arbitraging against Kalshi, and providing liquidity at scale.

---

## Modules

### 1. Latency Sniper (`modules/latency-sniper`)
Detects real-world sports/football events via live data feeds (API-Football / API-Sports) and fires orders on Polymarket before the market prices update. Targets the latency gap between event occurrence and market reaction.

- Real-time event detection (goals, red cards, match end)
- Market matcher: maps live events to active Polymarket contracts
- Pricing utilities: fair-value estimation post-event

### 2. Resolution Arbitrage (`modules/resolution-arb`)
Monitors markets where the real-world outcome is already known but Polymarket resolution is pending. Buys at a discount against near-certain resolution value.

- Tracks confirmed outcomes vs. unresolved markets
- Computes expected value given time-to-resolution and slippage

### 3. Cross-Market Arbitrage (`modules/cross-market-arb`)
Identifies price discrepancies between equivalent contracts on Polymarket and Kalshi. Executes simultaneous opposing positions to lock in risk-free spread.

- Continuous price feed diffing across platforms
- Spread threshold filtering with configurable min profit

### 4. Market Making (`modules/shared`)
Liquidity provision module — quotes two-sided markets with dynamic spread adjustment based on inventory and volatility.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill env
cp .env.example .env

# 3. Build
npm run build

# 4. Run (paper mode by default)
TRADING_MODE=paper npx tsx src/index.ts
```

---

## Environment Variables

See [`.env.example`](.env.example) for the full list. Key vars:

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Wallet private key for signing orders |
| `POLYMARKET_API_KEY` | CLOB API key |
| `TRADING_MODE` | `paper` (default) or `live` |
| `MAX_POSITION_SIZE_USDC` | Per-trade size cap |
| `DAILY_LOSS_LIMIT_USDC` | Hard stop circuit breaker |
| `ENABLE_LATENCY_SNIPER` | Toggle latency sniper module |
| `ENABLE_RESOLUTION_ARB` | Toggle resolution arb module |

---

## Project Structure

```
.
├── src/                    # Core SDK (original)
├── modules/
│   ├── latency-sniper/     # Sports event detection + order sniping
│   ├── resolution-arb/     # Resolution delay arbitrage
│   ├── cross-market-arb/   # Polymarket vs Kalshi arb
│   └── shared/             # Risk manager, Supabase client, logger
├── scripts/                # Utility scripts
├── examples/               # SDK usage examples
└── dist/                   # Compiled output
```

---

## Risk Management

All modules route through `modules/shared/risk-manager.ts` which enforces:
- Per-trade position size limits
- Daily loss circuit breaker
- Cooldown periods after consecutive losses

**Default mode is `paper` trading. Set `TRADING_MODE=live` only after thorough testing.**

---

## Credits

This project is built on top of [MrFadiAi/Polymarket-bot](https://github.com/MrFadiAi/Polymarket-bot) (originally `@catalyst-team/poly-sdk`), an open-source TypeScript SDK for Polymarket. Full credit to the original authors for the foundational SDK, CLOB client integration, and strategy examples.

---

## License

MIT
