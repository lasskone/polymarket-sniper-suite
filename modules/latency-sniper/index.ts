/**
 * Latency Sniper — main orchestration loop.
 *
 * Each tick:
 *   1. pollLiveMatches()  → new events since last tick
 *   2. Log every new event (market matching + trade execution: next step)
 *   3. Sleep for pollIntervalMs
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig } from '../shared/config.js';
import { loadLatencySniperConfig } from './config.js';
import { EventDetector, type NewEvent } from './event-detector.js';
import { createLogger } from '../shared/logger.js';

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
        await handleNewEvent(ne, cfg.tradingMode, cfg.minProfitThreshold);
      }
    } catch (err) {
      log.error('Unhandled error in poll loop', { error: String(err), tick: tickCount });
    }

    // Sleep for the remainder of the interval
    const elapsed = Date.now() - tickStart;
    const sleepMs = Math.max(0, cfg.pollIntervalMs - elapsed);
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// Event handler — logs event, placeholder for market matching + execution
// ---------------------------------------------------------------------------

async function handleNewEvent(
  ne: NewEvent,
  tradingMode: 'paper' | 'live',
  minProfitThreshold: number,
): Promise<void> {
  const { match, event } = ne;

  log.info('New event — evaluating opportunity', {
    fixtureId: match.fixtureId,
    league: match.league,
    match: `${match.homeTeam.name} ${match.score.home}–${match.score.away} ${match.awayTeam.name}`,
    eventType: event.type,
    eventDetail: event.detail,
    team: event.team.name,
    player: event.player.name,
    minute: event.time,
  });

  // ── TODO (next step): Market matching ─────────────────────────────────────
  // const targets = await marketMatcher.findTargets(ne);
  //
  // ── TODO (next step): Trade execution ─────────────────────────────────────
  // for (const target of targets) {
  //   if (target.edgePct < minProfitThreshold) continue;
  //   const check = await riskManager.checkOrder(...);
  //   if (!check.allowed) { log.warn(...); continue; }
  //   if (tradingMode === 'paper') { log.info('PAPER trade', target); continue; }
  //   await orderClient.place(target, check.adjustedSize);
  // }

  log.debug('Opportunity evaluation complete (market matching not yet wired)', {
    fixtureId: match.fixtureId,
    eventType: event.type,
    tradingMode,
    minProfitThreshold,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
