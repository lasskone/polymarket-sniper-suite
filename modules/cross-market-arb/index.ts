/**
 * Cross-Market Arbitrage module — Polymarket vs Kalshi.
 *
 * Continuously diffs prices for equivalent contracts on both platforms.
 * When the spread exceeds minSpreadPct, executes opposing positions to
 * lock in a near-risk-free profit.
 */

import { crossMarketArbConfig } from './config.js';
import { logger } from '../shared/logger.js';

export async function runCrossMarketArb(): Promise<void> {
  if (!crossMarketArbConfig.enabled) {
    logger.info(
      '[CrossMarketArb] Module disabled — set ENABLE_CROSS_MARKET_ARB=true to activate.',
    );
    return;
  }

  logger.info('[CrossMarketArb] Starting cross-market arbitrage scanner...');

  // TODO:
  //   1. Build a market-pair map: Polymarket conditionId <-> Kalshi marketTicker.
  //   2. Poll both price feeds on crossMarketArbConfig.pollIntervalMs cadence.
  //   3. For each pair where |polyPrice - kalshiPrice| > minSpreadPct:
  //      a. Buy cheaper side, sell more expensive side simultaneously.
  //      b. Enforce that combined position ≤ maxPositionSizeUsdc.
  //   4. Monitor legs for fill confirmation; log to Supabase.

  logger.info('[CrossMarketArb] Stub — awaiting market-pair registry and Kalshi client.');
}
