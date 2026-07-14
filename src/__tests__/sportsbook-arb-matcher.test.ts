/**
 * Unit tests for sportsbook-arb-matcher pure functions.
 *
 * All functions are pure (no I/O, no network). Tests cover:
 *   - normalizeTeamName: suffix stripping, alias lookup, punctuation
 *   - matchFixtureToPolymarketMarket: Yes/No binary match, named-outcome match,
 *     no match, ambiguous → null + callback, date-window filtering
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeTeamName,
  matchFixtureToPolymarketMarket,
  type PolymarketSoccerMarket,
} from '../services/sportsbook-arb-matcher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMarket(
  overrides: Partial<PolymarketSoccerMarket> & { question: string; endDate: Date },
): PolymarketSoccerMarket {
  return {
    conditionId:   '0xabc',
    outcomes:      ['Yes', 'No'],
    outcomePrices: [0.55, 0.45],
    active:        true,
    closed:        false,
    liquidity:     1000,
    ...overrides,
  };
}

/** A Betfair fixture kicking off at noon UTC on 2026-07-20. */
const BASE_FIXTURE = {
  fixtureId:        'id_test_001',
  participant1Name: 'Manchester United FC',
  participant2Name: 'Liverpool FC',
  startTime:        '2026-07-20T12:00:00Z',
};

const KICKOFF = new Date(BASE_FIXTURE.startTime).getTime();
const D = (offsetMs: number) => new Date(KICKOFF + offsetMs);

// ── normalizeTeamName ─────────────────────────────────────────────────────────

describe('normalizeTeamName', () => {
  it('lowercases and trims', () => {
    expect(normalizeTeamName('  Arsenal  ')).toBe('arsenal');
  });

  it('strips " FC" suffix', () => {
    expect(normalizeTeamName('Liverpool FC')).toBe('liverpool');
  });

  it('strips " AFC" suffix (alias then applies: west ham → west ham united)', () => {
    // " AFC" is stripped → "west ham" → TEAM_ALIASES maps → "west ham united"
    expect(normalizeTeamName('West Ham AFC')).toBe('west ham united');
  });

  it('strips " Football Club" suffix', () => {
    expect(normalizeTeamName('Chelsea Football Club')).toBe('chelsea');
  });

  it('strips " SC" suffix', () => {
    expect(normalizeTeamName('Celtic SC')).toBe('celtic');
  });

  it('strips multiple suffixes iteratively', () => {
    // "Tottenham Hotspur FC SC" → strip " SC" → "tottenham hotspur fc" → strip " FC"
    expect(normalizeTeamName('Tottenham Hotspur FC SC')).toBe('tottenham hotspur');
  });

  it('applies alias table after suffix stripping', () => {
    // "Manchester United FC" → strip " FC" → "manchester united" → alias: "manchester united"
    expect(normalizeTeamName('Manchester United FC')).toBe('manchester united');
  });

  it('alias: Man Utd → manchester united', () => {
    expect(normalizeTeamName('Man Utd')).toBe('manchester united');
  });

  it('alias: Man City → manchester city', () => {
    expect(normalizeTeamName('Man City')).toBe('manchester city');
  });

  it('alias: PSG → paris saint-germain', () => {
    expect(normalizeTeamName('PSG')).toBe('paris saint-germain');
  });

  it('alias: BVB → borussia dortmund', () => {
    expect(normalizeTeamName('BVB')).toBe('borussia dortmund');
  });

  it('alias: Spurs → tottenham hotspur', () => {
    expect(normalizeTeamName('Spurs')).toBe('tottenham hotspur');
  });

  it('strips punctuation except spaces, hyphens, ampersands, apostrophes', () => {
    // "Brighton & Hove Albion" — & is preserved
    expect(normalizeTeamName('Brighton & Hove Albion')).toBe('brighton & hove albion');
  });

  it('idempotent: normalising twice gives the same result', () => {
    const names = ['Manchester United FC', 'PSG', 'bvb', 'Liverpool FC'];
    for (const n of names) {
      const once  = normalizeTeamName(n);
      const twice = normalizeTeamName(once);
      expect(twice).toBe(once);
    }
  });
});

// ── matchFixtureToPolymarketMarket ────────────────────────────────────────────

describe('matchFixtureToPolymarketMarket — Yes/No binary', () => {
  it('matches home team from "Will [home] beat [away]?" question', () => {
    const market = makeMarket({
      question:      'Will Manchester United beat Liverpool?',
      endDate:       D(15 * 60 * 1000),   // 15 min after kickoff
      outcomePrices: [0.60, 0.40],
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(1);
    expect(results[0]!.betfairSide).toBe('home');
    expect(results[0]!.polymarketPrice).toBeCloseTo(0.60, 5);
    expect(results[0]!.matchType).toBe('yes_no');
  });

  it('matches away team from "Will [away] beat [home]?" question', () => {
    const market = makeMarket({
      question:      'Will Liverpool beat Manchester United?',
      endDate:       D(15 * 60 * 1000),
      outcomePrices: [0.45, 0.55],
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(1);
    expect(results[0]!.betfairSide).toBe('away');
    expect(results[0]!.polymarketPrice).toBeCloseTo(0.45, 5);
  });

  it('single-team "Will [home] win?" — home match', () => {
    const market = makeMarket({
      question:      'Will Manchester United win on 2026-07-20?',
      endDate:       D(20 * 60 * 1000),   // 20 min after kickoff
      outcomePrices: [0.55, 0.45],
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(1);
    expect(results[0]!.betfairSide).toBe('home');
    expect(results[0]!.polymarketPrice).toBeCloseTo(0.55, 5);
  });

  it('single-team "Will [away] win?" — away match', () => {
    const market = makeMarket({
      question:      'Will Liverpool win on 2026-07-20?',
      endDate:       D(20 * 60 * 1000),
      outcomePrices: [0.40, 0.60],
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(1);
    expect(results[0]!.betfairSide).toBe('away');
    expect(results[0]!.polymarketPrice).toBeCloseTo(0.40, 5);
  });
});

describe('matchFixtureToPolymarketMarket — named-outcome (Team-to-Advance style)', () => {
  it('matches both home and away from ["Manchester United", "Liverpool"] outcomes', () => {
    const market = makeMarket({
      question:      'Manchester United vs. Liverpool: Team to Advance',
      outcomes:      ['Manchester United', 'Liverpool'],
      outcomePrices: [0.58, 0.42],
      endDate:       D(20 * 60 * 1000),
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(2);

    const homeResult = results.find((r) => r.betfairSide === 'home');
    const awayResult = results.find((r) => r.betfairSide === 'away');

    expect(homeResult).toBeDefined();
    expect(homeResult!.polymarketPrice).toBeCloseTo(0.58, 5);
    expect(homeResult!.matchType).toBe('named');

    expect(awayResult).toBeDefined();
    expect(awayResult!.polymarketPrice).toBeCloseTo(0.42, 5);
  });

  it('normalises outcome names (handles "Manchester United FC" in outcomes)', () => {
    const market = makeMarket({
      question:      'Man Utd vs. Liverpool: Who Advances',
      outcomes:      ['Man Utd', 'Liverpool'],
      outcomePrices: [0.60, 0.40],
      endDate:       D(20 * 60 * 1000),
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    const homeResult = results.find((r) => r.betfairSide === 'home');
    expect(homeResult).toBeDefined();
    expect(homeResult!.polymarketPrice).toBeCloseTo(0.60, 5);
  });

  it('skips O/U market (outcomes = ["Over", "Under"])', () => {
    const market = makeMarket({
      question:      'Manchester United vs. Liverpool: O/U 2.5',
      outcomes:      ['Over', 'Under'],
      outcomePrices: [0.48, 0.52],
      endDate:       D(20 * 60 * 1000),
    });

    const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
    expect(results).toHaveLength(0);
  });
});

describe('matchFixtureToPolymarketMarket — date window', () => {
  const validQuestion = 'Will Manchester United beat Liverpool?';

  it('accepts endDate 15 min after kickoff', () => {
    const m = makeMarket({ question: validQuestion, endDate: D(15 * 60 * 1000) });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(1);
  });

  it('accepts endDate 20 hours after kickoff', () => {
    const m = makeMarket({ question: validQuestion, endDate: D(20 * 60 * 60 * 1000) });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(1);
  });

  it('accepts endDate 5 hours BEFORE kickoff (edge: early-close market)', () => {
    const m = makeMarket({ question: validQuestion, endDate: D(-5 * 60 * 60 * 1000) });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(1);
  });

  it('rejects endDate 7 hours before kickoff (outside -6h window)', () => {
    const m = makeMarket({ question: validQuestion, endDate: D(-7 * 60 * 60 * 1000) });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });

  it('rejects endDate 31 hours after kickoff (outside +30h window)', () => {
    const m = makeMarket({ question: validQuestion, endDate: D(31 * 60 * 60 * 1000) });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });

  it('rejects tournament-winner market with far-future endDate', () => {
    const m = makeMarket({
      question: 'Will Manchester United win the Premier League?',
      endDate:  new Date('2027-05-01T00:00:00Z'),   // months away
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });
});

describe('matchFixtureToPolymarketMarket — ambiguity and filtering', () => {
  it('two home candidates → no home result + onAmbiguous called', () => {
    const m1 = makeMarket({
      question:    'Will Manchester United win?',
      endDate:     D(15 * 60 * 1000),
      conditionId: '0x001',
    });
    const m2 = makeMarket({
      question:    'Will Manchester United beat Liverpool?',
      endDate:     D(15 * 60 * 1000),
      conditionId: '0x002',
    });

    const ambiguousCalls: Array<{ side: string; count: number }> = [];
    const results = matchFixtureToPolymarketMarket(
      BASE_FIXTURE,
      [m1, m2],
      (_fid, side, candidates) => {
        ambiguousCalls.push({ side, count: candidates.length });
      },
    );

    // No home result (ambiguous); away might still match if a market names Liverpool first
    const homeResult = results.find((r) => r.betfairSide === 'home');
    expect(homeResult).toBeUndefined();

    expect(ambiguousCalls).toHaveLength(1);
    expect(ambiguousCalls[0]!.side).toBe('home');
    expect(ambiguousCalls[0]!.count).toBe(2);
  });

  it('skips inactive markets', () => {
    const m = makeMarket({
      question: 'Will Manchester United beat Liverpool?',
      endDate:  D(15 * 60 * 1000),
      active:   false,
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });

  it('skips closed markets', () => {
    const m = makeMarket({
      question: 'Will Manchester United beat Liverpool?',
      endDate:  D(15 * 60 * 1000),
      closed:   true,
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });

  it('returns empty array when no market matches', () => {
    const m = makeMarket({
      question: 'Will Arsenal beat Chelsea?',   // wrong teams
      endDate:  D(15 * 60 * 1000),
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [m])).toHaveLength(0);
  });

  it('onAmbiguous is optional — does not throw when omitted', () => {
    const m1 = makeMarket({ question: 'Will Manchester United win?', endDate: D(15 * 60 * 1000), conditionId: '0x001' });
    const m2 = makeMarket({ question: 'Will Manchester United beat Liverpool?', endDate: D(15 * 60 * 1000), conditionId: '0x002' });
    expect(() => matchFixtureToPolymarketMarket(BASE_FIXTURE, [m1, m2])).not.toThrow();
  });

  it('handles empty market list', () => {
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [])).toHaveLength(0);
  });
});

describe('matchFixtureToPolymarketMarket — blocklist filtering', () => {
  const endDate = D(15 * 60 * 1000);

  const blocklisted: Array<[string, string[]]> = [
    ['Exact Score: Manchester United 2 - 1 Liverpool?', ['Yes', 'No']],
    ['Will Manchester United vs. Liverpool end in a draw?', ['Yes', 'No']],
    ['Manchester United vs. Liverpool: Both Teams to Score', ['Yes', 'No']],
    ['Manchester United vs. Liverpool: Draw at halftime?', ['Yes', 'No']],
    ['Manchester United leading at halftime?', ['Yes', 'No']],
    ['Spread: Manchester United (-1.5)', ['Manchester United', 'Liverpool']],
    ['Manchester United vs. Liverpool: O/U 2.5', ['Over', 'Under']],
  ];

  for (const [question, outcomes] of blocklisted) {
    it(`blocks: "${question}"`, () => {
      const market = makeMarket({ question, outcomes, outcomePrices: [0.5, 0.5], endDate });
      const results = matchFixtureToPolymarketMarket(BASE_FIXTURE, [market]);
      expect(results).toHaveLength(0);
    });
  }

  it('does NOT block "Will Manchester United beat Liverpool?" (contains "beat")', () => {
    const market = makeMarket({
      question: 'Will Manchester United beat Liverpool?',
      endDate,
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [market])).toHaveLength(1);
  });

  it('does NOT block "Manchester United vs. Liverpool: Team to Advance" (named, no blocklist match)', () => {
    const market = makeMarket({
      question:      'Manchester United vs. Liverpool: Team to Advance',
      outcomes:      ['Manchester United', 'Liverpool'],
      outcomePrices: [0.55, 0.45],
      endDate,
    });
    expect(matchFixtureToPolymarketMarket(BASE_FIXTURE, [market])).toHaveLength(2);
  });
});

describe('matchFixtureToPolymarketMarket — alias integration', () => {
  it('matches Man Utd fixture name against "Manchester United" in question', () => {
    const fixture = {
      ...BASE_FIXTURE,
      participant1Name: 'Man Utd',          // Betfair short name
      participant2Name: 'Liverpool FC',
    };
    const market = makeMarket({
      question: 'Will Manchester United beat Liverpool?',  // Polymarket full name
      endDate:  D(15 * 60 * 1000),
    });

    const results = matchFixtureToPolymarketMarket(fixture, [market]);
    expect(results).toHaveLength(1);
    expect(results[0]!.betfairSide).toBe('home');
  });
});
