/**
 * Latency Sniper — main orchestration loop.
 *
 * Each tick:
 *   1. pollLiveMatches()           → new events since last tick
 *   2. findMatchingMarket(event)   → best Polymarket market for the event
 *   3. estimatePriceImpact(…)      → expected price movement + edge
 *   4. Filter by minProfitThreshold
 *   5. Log full opportunity details
 *   6. TODO: risk check → trade execution
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig }              from '../shared/config.js';
import { loadLatencySniperConfig } from './config.js';
import { EventDetector, type NewEvent } from './event-detector.js';
import { MarketMatcher }           from './market-matcher.js';
import { estimatePriceImpact }     from './utils/pricing.js';
import { createLogger }            from '../shared/logger.js';

const log = createLogger('latency-sniper');

export async function runLatencySniper(): Promise<void> {
  const mainConfig = loadConfig();
  const cfg = loadLatencySniperConfig(mainConfig);

  if (!cfg.enabled) {
    log.info('Module disabled — set ENABLE_LATENCY_SNIPER=true to activate.');
    return;
  }

  log.info('Starting latency sniper', {
    tradingMode: cfg.tradingMode,
    pollIntervalMs: cfg.pollIntervalMs,
    targetLeagues: cfg.targetLeagues,
    targetEventTypes: cfg.targetEventTypes,
    maxApiCallsPerMinute: cfg.maxApiCallsPerMinute,
  });

  const detector = new EventDetector(cfg);
  const matcher  = new MarketMatcher();

  let tickCount = 0;

  while (true) {
    tickCount++;
    const tickStart = Date.now();

    try {
      const newEvents = await detector.pollLiveMatches();

      if (newEvents.length === 0) {
        log.debug('Tick complete — no new events', { tick: tickCount });
      }

      for (const ne of newEvents) {
        await handleNewEvent(ne, matcher, cfg.tradingMode, cfg.minProfitThreshold);
      }
    } catch (err) {
      log.error('Unhandled error in poll loop', { error: String(err), tick: tickCount });
    }

    const elapsed  = Date.now() - tickStart;
    const sleepMs  = Math.max(0, cfg.pollIntervalMs - elapsed);
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// Per-event handler
// ---------------------------------------------------------------------------

async function handleNewEvent(
  ne: NewEvent,
  matcher: MarketMatcher,
  tradingMode: 'paper' | 'live',
  minProfitThreshold: number,
): Promise<void> {
  const { match, event } = ne;

  log.info('Event detected', {
    fixtureId: match.fixtureId,
    league: match.league,
    match: `${match.homeTeam.name} ${match.score.home}–${match.score.away} ${match.awayTeam.name}`,
    eventType: event.type,
    eventDetail: event.detail,
    team: event.team.name,
    player: event.player.name,
    minute: event.time,
  });

  // ── Step 1: Find matching Polymarket market ───────────────────────────────
  const matchResult = await matcher.findMatchingMarket(ne);

  if (!matchResult) {
    log.debug('No matching market found — skipping event', {
      fixtureId: match.fixtureId,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
    });
    return;
  }

  // ── Step 2: Estimate price impact ─────────────────────────────────────────
  const estimate = estimatePriceImpact(
    ne,
    matchResult.market,
    matchResult.side,
    matchResult.currentPrice,
  );

  // ── Step 3: Edge filter ───────────────────────────────────────────────────
  if (estimate.edge < minProfitThreshold) {
    log.debug('Edge below threshold — skipping', {
      edge: estimate.edge,
      threshold: minProfitThreshold,
      market: matchResult.market.question,
    });
    return;
  }

  // ── Step 4: Log full opportunity ──────────────────────────────────────────
  log.info('OPPORTUNITY IDENTIFIED', {
    // Event
    fixtureId:     match.fixtureId,
    league:        match.league,
    match:         `${match.homeTeam.name} vs ${match.awayTeam.name}`,
    eventType:     event.type,
    eventDetail:   event.detail,
    team:          event.team.name,
    minute:        event.time,
    score:         match.score,

    // Market
    marketId:      matchResult.market.id,
    question:      matchResult.market.question,
    relevance:     matchResult.relevanceScore,
    side:          matchResult.side,
    liquidity:     matchResult.market.liquidity,
    volume:        matchResult.market.volume,

    // Pricing
    currentPrice:  estimate.currentPrice,
    expectedPrice: estimate.expectedPrice,
    edge:          estimate.edge,
    confidence:    estimate.confidence,
    reasoning:     estimate.reasoning,

    // Execution intent
    tradingMode,
  });

  // ── Step 5: TODO — Risk check ─────────────────────────────────────────────
  // const check = await riskManager.checkOrder(
  //   'latency-sniper', matchResult.market.id, matchResult.side,
  //   cfg.maxPositionSizeUsdc, matchResult.currentPrice,
  // );
  // if (!check.allowed) {
  //   log.warn('Risk check blocked trade', { reason: check.reason });
  //   return;
  // }

  // ── Step 6: TODO — Execute trade ──────────────────────────────────────────
  // if (tradingMode === 'paper') {
  //   log.info('PAPER: would place order', {
  //     conditionId: matchResult.market.conditionId,
  //     side: matchResult.side,
  //     size: check.adjustedSize,
  //     price: matchResult.currentPrice,
  //   });
  //   return;
  // }
  // await orderClient.place({ ... });
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
