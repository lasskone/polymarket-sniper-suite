/**
 * scripts/test-market-matcher.ts
 *
 * Integration test for MarketMatcher + pricing model.
 *
 * Run with:  npm run test:market-matcher
 *
 * Sections:
 *   1. getActiveMarkets() — logs count + top 5 by volume
 *   2. Mock events — goal, red card, penalty — find market + price estimate
 *   3. Team alias resolution test
 *   4. Relevance scoring unit test (no network call)
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { MarketMatcher }       from '../modules/latency-sniper/market-matcher.js';
import { estimatePriceImpact } from '../modules/latency-sniper/utils/pricing.js';
import { createLogger }        from '../modules/shared/logger.js';
import type { NewEvent, Match, Event, Team } from '../modules/latency-sniper/event-detector.js';

const log = createLogger('test-market-matcher');

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeTeam(id: number, name: string): Team {
  return { id, name, logo: '' };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    fixtureId: 999001,
    league: 'Premier League',
    homeTeam: makeTeam(33, 'Manchester United'),
    awayTeam: makeTeam(40, 'Liverpool'),
    status: '1H',
    minute: 25,
    score: { home: 1, away: 0 },
    events: [],
    lastUpdate: Date.now(),
    ...overrides,
  };
}

function makeEvent(type: string, detail: string, team: Team, minute: number): Event {
  return {
    time: minute,
    type,
    detail,
    team,
    player: { id: 1, name: 'Test Player' },
  };
}

function makeNewEvent(match: Match, event: Event): NewEvent {
  return { match, event, detectedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function sectionActiveMarkets(matcher: MarketMatcher): Promise<boolean> {
  log.info('── Section 1: getActiveMarkets() ──');

  try {
    const markets = await matcher.getActiveMarkets();
    log.info(`[OK] Fetched ${markets.length} active soccer/football markets`);

    if (markets.length > 0) {
      log.info('Top 5 markets by volume:');
      markets.slice(0, 5).forEach((m, i) => {
        log.info(`  ${i + 1}.`, {
          question: m.question,
          volume: m.volume,
          liquidity: m.liquidity,
          endDate: m.endDate,
          tags: m.tags.slice(0, 3),
          yesPrice: m.outcomePrices[0],
          noPrice: m.outcomePrices[1],
        });
      });
    } else {
      log.info('  (No soccer markets active right now — this is normal outside match weeks)');
    }

    return true;
  } catch (err) {
    log.error('[FAIL] getActiveMarkets() threw', { error: String(err) });
    return false;
  }
}

async function sectionMockEvents(matcher: MarketMatcher): Promise<boolean> {
  log.info('── Section 2: Mock event → market match → price estimate ──');

  const scenarios: Array<{
    name: string;
    ne: NewEvent;
  }> = [
    {
      name: 'Goal by Man United (home, min 25)',
      ne: makeNewEvent(
        makeMatch({ minute: 25, score: { home: 1, away: 0 } }),
        makeEvent('Goal', 'Normal Goal', makeTeam(33, 'Manchester United'), 25),
      ),
    },
    {
      name: 'Red card for Liverpool (away, min 38)',
      ne: makeNewEvent(
        makeMatch({ minute: 38, score: { home: 0, away: 0 } }),
        makeEvent('Card', 'Red Card', makeTeam(40, 'Liverpool'), 38),
      ),
    },
    {
      name: 'Penalty awarded to Bayern Munich (home, min 55)',
      ne: makeNewEvent(
        makeMatch({
          fixtureId: 999002,
          league: 'Bundesliga',
          homeTeam: makeTeam(157, 'Bayern Munich'),
          awayTeam: makeTeam(165, 'Borussia Dortmund'),
          minute: 55,
          score: { home: 1, away: 1 },
        }),
        makeEvent('Var', 'Penalty Confirmed', makeTeam(157, 'Bayern Munich'), 55),
      ),
    },
    {
      name: 'Own goal by PSG (home, min 70)',
      ne: makeNewEvent(
        makeMatch({
          fixtureId: 999003,
          league: 'Ligue 1',
          homeTeam: makeTeam(85, 'Paris Saint-Germain'),
          awayTeam: makeTeam(80, 'Lyon'),
          minute: 70,
          score: { home: 1, away: 1 },
        }),
        makeEvent('Goal', 'Own Goal', makeTeam(85, 'Paris Saint-Germain'), 70),
      ),
    },
  ];

  let allOk = true;

  for (const { name, ne } of scenarios) {
    log.info(`\n  Scenario: ${name}`);

    const matchResult = await matcher.findMatchingMarket(ne);

    if (!matchResult) {
      log.info('  → No matching market found (normal outside of match week)', {
        homeTeam: ne.match.homeTeam.name,
        awayTeam: ne.match.awayTeam.name,
        league: ne.match.league,
      });
      continue;
    }

    const estimate = estimatePriceImpact(
      ne,
      matchResult.market,
      matchResult.side,
      matchResult.currentPrice,
    );

    log.info('  → Market found + price estimated', {
      question:      matchResult.market.question,
      relevance:     matchResult.relevanceScore,
      side:          matchResult.side,
      currentPrice:  estimate.currentPrice,
      expectedPrice: estimate.expectedPrice,
      edge:          estimate.edge,
      confidence:    estimate.confidence,
      reasoning:     estimate.reasoning,
    });

    if (typeof estimate.edge !== 'number' || typeof estimate.confidence !== 'number') {
      log.error(`  [FAIL] Invalid estimate shape`);
      allOk = false;
    } else {
      log.info(`  [OK]`);
    }
  }

  return allOk;
}

function sectionAliasResolution(matcher: MarketMatcher): boolean {
  log.info('── Section 3: Team alias resolution ──');

  const aliases: Array<[string, string]> = [
    ['Man United',           'Manchester United'],
    ['Man Utd',              'Manchester United'],
    ['Bayern',               'Bayern Munich'],
    ['Bayern München',       'Bayern Munich'],
    ['PSG',                  'Paris Saint-Germain'],
    ['Paris Saint-Germain',  'Paris Saint-Germain'],
    ['Spurs',                'Tottenham Hotspur'],
    ['BVB',                  'Borussia Dortmund'],
    // Non-alias — should return original
    ['Ajax',                 'Ajax'],
  ];

  let passed = 0;
  let failed = 0;

  for (const [input, expected] of aliases) {
    const match = makeMatch({ homeTeam: makeTeam(1, input), awayTeam: makeTeam(2, 'Opponent') });
    const ne = makeNewEvent(match, makeEvent('Goal', 'Normal Goal', makeTeam(1, input), 30));
    const { homeTeam } = matcher.extractTeamsFromEvent(ne);

    if (homeTeam === expected) {
      log.info(`  [OK]  "${input}" → "${homeTeam}"`);
      passed++;
    } else {
      log.error(`  [FAIL] "${input}" → "${homeTeam}" (expected "${expected}")`);
      failed++;
    }
  }

  log.info(`  Alias tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

function sectionRelevanceScoring(matcher: MarketMatcher): boolean {
  log.info('── Section 4: Relevance scoring (no network) ──');

  const ne = makeNewEvent(
    makeMatch(),
    makeEvent('Goal', 'Normal Goal', makeTeam(33, 'Manchester United'), 25),
  );

  const { homeTeam, awayTeam } = matcher.extractTeamsFromEvent(ne);

  const scenarios: Array<{
    desc: string;
    market: Parameters<typeof matcher.calculateMarketRelevance>[0];
    minExpected: number;
  }> = [
    {
      desc: 'Both teams + league tag',
      market: {
        id: 'a', conditionId: 'a', slug: 'a', description: '',
        question: 'Will Manchester United beat Liverpool in the Premier League?',
        outcomes: ['Yes', 'No'], outcomePrices: ['0.60', '0.40'],
        volume: 50000, liquidity: 20000,
        endDate: new Date(Date.now() + 86_400_000).toISOString(),
        tags: ['Sports', 'Soccer', 'Premier League'],
      },
      minExpected: 70,
    },
    {
      desc: 'Only one team mentioned',
      market: {
        id: 'b', conditionId: 'b', slug: 'b', description: '',
        question: 'Will Manchester United win this week?',
        outcomes: ['Yes', 'No'], outcomePrices: ['0.55', '0.45'],
        volume: 5000, liquidity: 1000,
        endDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        tags: ['Sports', 'Soccer'],
      },
      minExpected: 20,
    },
    {
      desc: 'Unrelated market — should score 0',
      market: {
        id: 'c', conditionId: 'c', slug: 'c', description: '',
        question: 'Will the US win the 2026 World Cup?',
        outcomes: ['Yes', 'No'], outcomePrices: ['0.15', '0.85'],
        volume: 100000, liquidity: 50000,
        endDate: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        tags: ['Sports', 'Soccer', 'World Cup'],
      },
      minExpected: 0,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const { desc, market, minExpected } of scenarios) {
    const score = matcher.calculateMarketRelevance(market, ne, homeTeam, awayTeam);
    const ok = minExpected === 0 ? score < 30 : score >= minExpected;
    const status = ok ? '[OK]' : '[FAIL]';
    log.info(`  ${status} "${desc}" score=${score} (min expected: ${minExpected})`);
    if (ok) passed++; else failed++;
  }

  log.info(`  Relevance tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== MarketMatcher + Pricing Test ===\n');

  const matcher = new MarketMatcher();

  const results: boolean[] = [
    await sectionActiveMarkets(matcher),
    await sectionMockEvents(matcher),
    sectionAliasResolution(matcher),
    sectionRelevanceScoring(matcher),
  ];

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
