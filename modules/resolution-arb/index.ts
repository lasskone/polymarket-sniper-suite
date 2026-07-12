/**
 * Resolution Arbitrage module.
 *
 * Monitors Polymarket markets where the real-world outcome is already
 * known (e.g., confirmed game result, election called) but the market
 * has not yet been resolved on-chain. Buys the winning outcome at a
 * discount vs the near-certain resolution value of 1.00 USDC.
 */

import { resolutionArbConfig } from './config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('resolution-arb');

export async function runResolutionArb(): Promise<void> {
  if (!resolutionArbConfig.enabled) {
    log.info('Module disabled — set ENABLE_RESOLUTION_ARB=true to activate.');
    return;
  }

  log.info('Starting resolution arbitrage scanner');

  // TODO: Subscribe to a resolution oracle feed or scrape known outcomes.
  // For each confirmed outcome:
  //   1. Fetch current market price for the winning outcome token.
  //   2. If price < (1 - minDiscountToFairValue), size a position up to
  //      maxPositionSizeUsdc via the CLOB client.
  //   3. Log entry, hold until resolution, record P&L to Supabase.

  log.info('Stub — awaiting oracle integration');
}
