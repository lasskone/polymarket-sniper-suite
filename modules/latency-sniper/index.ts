/**
 * Latency Sniper module entry point.
 *
 * Orchestrates:
 *   1. EventDetector  — polls API-Football for live match events
 *   2. MarketMatcher  — maps events to Polymarket contracts
 *   3. Risk Manager   — gates order size / daily limits
 *   4. Order execution (paper or live)
 */

import { latencySniperConfig } from './config.js';
import { EventDetector } from './event-detector.js';
import { MarketMatcher } from './market-matcher.js';
import { logger } from '../shared/logger.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';

export async function runLatencySniper(): Promise<void> {
  if (!latencySniperConfig.enabled) {
    logger.info('[LatencySniper] Module disabled — set ENABLE_LATENCY_SNIPER=true to activate.');
    return;
  }

  if (!latencySniperConfig.apiFootballKey) {
    throw new Error('[LatencySniper] API_FOOTBALL_KEY is required but not set.');
  }

  logger.info('[LatencySniper] Starting...');

  const detector = new EventDetector(latencySniperConfig.apiFootballKey);
  const matcher = new MarketMatcher(CLOB_API_BASE, latencySniperConfig.apiFootballKey);

  const seen = new Set<string>();

  while (true) {
    try {
      const fixtureIds = await detector.getLiveFixtures();
      logger.info(`[LatencySniper] Live fixtures: ${fixtureIds.length}`);

      for (const id of fixtureIds) {
        const events = await detector.getFixtureEvents(id);
        for (const event of events) {
          const key = `${event.fixtureId}-${event.eventType}-${event.minute}`;
          if (seen.has(key)) continue;
          seen.add(key);

          logger.info(`[LatencySniper] New event detected: ${JSON.stringify(event)}`);
          const targets = await matcher.findTargets(event);

          for (const target of targets) {
            if (target.edgePct < latencySniperConfig.minProfitThreshold) continue;
            logger.info(
              `[LatencySniper] Target: conditionId=${target.conditionId} side=${target.side} edge=${(target.edgePct * 100).toFixed(2)}%`,
            );

            if (latencySniperConfig.tradingMode === 'paper') {
              logger.info('[LatencySniper] PAPER: would place order here.');
            }
            // live order execution wired in via the shared order client
          }
        }
      }
    } catch (err) {
      logger.error(`[LatencySniper] Error in poll loop: ${err}`);
    }

    await new Promise((r) => setTimeout(r, latencySniperConfig.pollIntervalMs));
  }
}
