/**
 * scripts/test-api-football.ts
 *
 * Integration test for the API-Football EventDetector.
 *
 * Run with:  npm run test:api-football
 *
 * What it does:
 *   1. Env check
 *   2. getLiveMatches() — logs whatever matches are live right now
 *   3. Two pollLiveMatches() calls with a 15-second gap to test event detection
 *   4. Error handling test with a deliberately invalid API key
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig } from '../modules/shared/config.js';
import { loadLatencySniperConfig } from '../modules/latency-sniper/config.js';
import { EventDetector } from '../modules/latency-sniper/event-detector.js';
import { createLogger } from '../modules/shared/logger.js';

const log = createLogger('test-api-football');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function sectionLiveMatches(detector: EventDetector): Promise<boolean> {
  log.info('── Section 1: getLiveMatches() ──');

  try {
    const matches = await detector.getLiveMatches();

    if (matches.length === 0) {
      log.info('[OK] getLiveMatches() returned 0 matches — no live games in target leagues right now');
      log.info('     (This is expected outside peak match hours)');
    } else {
      log.info(`[OK] getLiveMatches() returned ${matches.length} live match(es)`);
      for (const m of matches) {
        log.info('  Match', {
          fixtureId: m.fixtureId,
          league: m.league,
          home: m.homeTeam.name,
          away: m.awayTeam.name,
          status: m.status,
          minute: m.minute,
          score: `${m.score.home}–${m.score.away}`,
        });
      }
    }
    return true;
  } catch (err) {
    log.error('[FAIL] getLiveMatches() threw unexpectedly', { error: String(err) });
    return false;
  }
}

async function sectionEventDetection(detector: EventDetector): Promise<boolean> {
  log.info('── Section 2: pollLiveMatches() × 2 (15-second gap) ──');

  try {
    // First poll — seeds internal state
    log.info('Poll #1 …');
    const poll1 = await detector.pollLiveMatches();
    log.info(`[OK] Poll #1 complete`, {
      newEvents: poll1.length,
      note: 'All events are "new" on first call (no prior state)',
    });

    for (const ne of poll1) {
      log.info('  Event (poll 1)', {
        fixture: ne.match.fixtureId,
        league: ne.match.league,
        match: `${ne.match.homeTeam.name} vs ${ne.match.awayTeam.name}`,
        type: ne.event.type,
        detail: ne.event.detail,
        team: ne.event.team.name,
        minute: ne.event.time,
      });
    }

    log.info('Waiting 15 seconds for potential new events …');
    await sleep(15_000);

    // Second poll — should only return events that happened in the gap
    log.info('Poll #2 …');
    const poll2 = await detector.pollLiveMatches();
    log.info(`[OK] Poll #2 complete`, {
      newEvents: poll2.length,
      note: poll2.length === 0
        ? 'No new events in the 15-second window (expected during quiet periods)'
        : 'New events detected!',
    });

    for (const ne of poll2) {
      log.info('  NEW Event (poll 2)', {
        fixture: ne.match.fixtureId,
        league: ne.match.league,
        match: `${ne.match.homeTeam.name} vs ${ne.match.awayTeam.name}`,
        type: ne.event.type,
        detail: ne.event.detail,
        team: ne.event.team.name,
        minute: ne.event.time,
        score: ne.match.score,
      });
    }

    return true;
  } catch (err) {
    log.error('[FAIL] pollLiveMatches() threw unexpectedly', { error: String(err) });
    return false;
  }
}

async function sectionInvalidKey(): Promise<boolean> {
  log.info('── Section 3: Error handling — invalid API key ──');

  const badConfig = {
    enabled: true,
    apiFootballKey: 'INVALID_KEY_FOR_TESTING',
    pollIntervalMs: 10_000,
    minProfitThreshold: 0.05,
    maxPositionSizeUsdc: 100,
    tradingMode: 'paper' as const,
    targetLeagues: ['Premier League'],
    targetEventTypes: ['Goal', 'Card'],
    maxApiCallsPerMinute: 8,
    minOrderBookDepthUsdc: 500,
  };

  const badDetector = new EventDetector(badConfig);

  try {
    const matches = await badDetector.getLiveMatches();
    // With an invalid key, API-Football returns a 401 — EventDetector
    // logs the error and returns [] instead of throwing.
    if (Array.isArray(matches)) {
      log.info('[OK] Invalid key returned empty array (no crash)', { count: matches.length });
      return true;
    }
    log.error('[FAIL] Expected empty array, got non-array');
    return false;
  } catch (err) {
    log.error('[FAIL] getLiveMatches() should not throw on auth error', { error: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== API-Football EventDetector Test ===\n');

  // ── Config ────────────────────────────────────────────────────────────────
  let detector: EventDetector;
  try {
    const mainConfig = loadConfig();
    const sniperConfig = loadLatencySniperConfig(mainConfig);

    log.info('Config loaded', {
      targetLeagues: sniperConfig.targetLeagues,
      targetEventTypes: sniperConfig.targetEventTypes,
      pollIntervalMs: sniperConfig.pollIntervalMs,
      maxApiCallsPerMinute: sniperConfig.maxApiCallsPerMinute,
    });

    detector = new EventDetector(sniperConfig);
  } catch (err) {
    log.error('Config load failed', { error: String(err) });
    log.error('Have you set API_FOOTBALL_KEY in .env?');
    process.exit(1);
  }

  // ── Run sections ──────────────────────────────────────────────────────────
  const results: boolean[] = [];
  results.push(await sectionLiveMatches(detector));
  results.push(await sectionEventDetection(detector));
  results.push(await sectionInvalidKey());

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;

  console.log('\n================================');
  console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
  console.log('================================');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
