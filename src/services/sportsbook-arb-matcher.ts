/**
 * Team-name normalisation and fixture-to-Polymarket market matching.
 *
 * Used by SportsbookArbService to match Betfair Exchange fixtures (fetched
 * via OddsPapi) to Polymarket markets (fetched directly from the Gamma API).
 *
 * ── Design overview ────────────────────────────────────────────────────────────
 *
 * Two-stage match:
 *   1. Date window: Gamma market.endDate must fall within
 *      [kickoff − 6 h, kickoff + 30 h].
 *      Soccer endDates are typically kickoff+15 min (market closes near match
 *      start) to kickoff+24 h (slow-resolving markets). 30 h captures all real
 *      markets while excluding long-running tournament winner markets (weeks
 *      in the future).  6 h before kickoff catches markets that close
 *      slightly early due to timezone rounding.
 *
 *   2. Team names: both normalised participant names must be present in the
 *      market (either in the question text OR in the outcomes array, depending
 *      on market type — see Polymarket market types below).
 *
 * Polymarket soccer market types (observed 2026-07-14):
 *   A. Single-team binary: "Will France win on 2026-07-14?"
 *      outcomes = ["Yes", "No"] — only one team in question text.
 *      We still require the DATE window to disambiguate (a team plays once/day).
 *
 *   B. Head-to-head binary: (not commonly seen but handled)
 *      outcomes = ["Yes", "No"], both teams in question.
 *
 *   C. Named-outcome head-to-head: "France vs. Spain: Team to Advance"
 *      outcomes = ["France", "Spain"] — team names ARE the outcomes.
 *      Both teams appear in outcomes[]; we extract prices by index.
 *
 *   D. O/U, Spread, Exact-score: skip — no Betfair moneyline to compare against.
 *
 * ── False-positive risk assessment ────────────────────────────────────────────
 *
 * Risk 1 — Two clubs with identical normalised names on the same day:
 *   E.g. two "Deportivo" clubs in different competitions.
 *   Mitigation: both team names must appear OR the date window is ≤6h wide.
 *   Residual risk: if BOTH teams have identical names AND dates overlap → the
 *   ambiguity check (>1 candidate → null + log) fires. NOT silently wrong.
 *
 * Risk 2 — Single-team "Will X win?" matching the wrong fixture:
 *   A team theoretically plays once per day in organised football, so the
 *   date window alone should be sufficient. If somehow two markets exist for
 *   the same team on the same endDate (e.g. rescheduled match), the ambiguity
 *   check fires.
 *
 * Risk 3 — Alias table gap (name not in the table):
 *   Result is no match (null, not a wrong match). Fails silently — add the
 *   alias and re-run. Log will show "no match" with the raw fixture names.
 *
 * Risk 4 — O/U or Spread market accidentally matching a team name:
 *   E.g. "France vs. Spain: France O/U 0.5" — contains both team names.
 *   Mitigation: we require outcomes to be either Yes/No OR the team names.
 *   O/U markets have outcomes ["Over","Under"]; Spread markets have outcomes
 *   that don't match team names. These are skipped by the outcome type check.
 *
 * ── Extending the alias table ──────────────────────────────────────────────────
 *
 * When a fixture appears in OddsPapi but doesn't match any Polymarket market
 * despite the teams being listed:
 *   1. Check the sportsbook-arb log for "no match for fixture" entries.
 *   2. Compare the raw Betfair name vs. the Polymarket question text.
 *   3. Add an entry: normalised_variant → canonical_normalised_form.
 *      Both key and value must be fully normalised (lowercased, suffix-stripped,
 *      no leading/trailing spaces).
 *
 * @module services/sportsbook-arb-matcher
 */

// ── Alias table ────────────────────────────────────────────────────────────────

/**
 * Maps a normalised team-name variant to its canonical normalised form.
 *
 * All entries are already lowercase and suffix-stripped. Both the key and
 * the value go through normalizeTeamName's suffix-stripping step first, so
 * you do NOT need to include the suffix in the key (e.g., write "man utd",
 * not "manchester united fc").
 *
 * To extend: add a new `'variant': 'canonical'` entry. The canonical form
 * should be whichever spelling appears most consistently on Polymarket.
 */
export const TEAM_ALIASES: Record<string, string> = {
  // ── English clubs ────────────────────────────────────────────────────────
  'man utd':                'manchester united',
  'manchester utd':         'manchester united',
  'man united':             'manchester united',
  'man city':               'manchester city',
  'spurs':                  'tottenham hotspur',
  'tottenham':              'tottenham hotspur',
  'wolves':                 'wolverhampton wanderers',
  'wolverhampton':          'wolverhampton wanderers',
  'newcastle':              'newcastle united',
  'west ham':               'west ham united',
  'nottm forest':           'nottingham forest',
  "nott'm forest":          'nottingham forest',
  'sheffield utd':          'sheffield united',
  'leeds':                  'leeds united',
  'leicester':              'leicester city',
  'brighton':               'brighton & hove albion',
  'brighton hove albion':   'brighton & hove albion',
  'luton':                  'luton town',
  'swansea':                'swansea city',
  'cardiff':                'cardiff city',
  'hull':                   'hull city',
  'stoke':                  'stoke city',
  'portsmouth':             'portsmouth',
  // ── Spanish clubs ────────────────────────────────────────────────────────
  'psg':                    'paris saint-germain',
  'paris sg':               'paris saint-germain',
  'paris saint germain':    'paris saint-germain',
  'atletico':               'atletico de madrid',
  'atletico madrid':        'atletico de madrid',
  'atl madrid':             'atletico de madrid',
  'real betis':             'real betis',
  // ── German clubs ─────────────────────────────────────────────────────────
  'fc bayern':              'bayern munich',
  'fc bayern münchen':      'bayern munich',
  'bay munich':             'bayern munich',
  'bvb':                    'borussia dortmund',
  'dortmund':               'borussia dortmund',
  'leverkusen':             'bayer leverkusen',
  'bayer leverkusen':       'bayer leverkusen',
  'rb leipzig':             'red bull leipzig',
  'rbl':                    'red bull leipzig',
  // ── Italian clubs ────────────────────────────────────────────────────────
  'inter milan':            'inter',
  'inter milan fc':         'inter',
  'ac milan':               'milan',
  'milan ac':               'milan',
  'juventus':               'juventus',
  'juve':                   'juventus',
  'napoli':                 'ssc napoli',
  // ── Dutch clubs ──────────────────────────────────────────────────────────
  'ajax':                   'afc ajax',
  'psv':                    'psv eindhoven',
  'az':                     'az alkmaar',
  // ── Portuguese clubs ─────────────────────────────────────────────────────
  'benfica':                'sl benfica',
  'porto':                  'porto',
  'sporting cp':            'sporting',
  'sporting lisbon':        'sporting',
  // ── Belgian clubs ────────────────────────────────────────────────────────
  'club brugge':            'club brugge',
  'anderlecht':             'rsc anderlecht',
  // ── Scottish clubs ───────────────────────────────────────────────────────
  'celtic':                 'celtic',
  'rangers':                'rangers',
  // ── National teams ───────────────────────────────────────────────────────
  'usa':                    'united states',
  'usmnt':                  'united states',
  // ── South American clubs ─────────────────────────────────────────────────
  'boca':                   'boca juniors',
  'river':                  'river plate',
  'flamengo':               'flamengo',
};

// ── Suffix stripping ──────────────────────────────────────────────────────────

/**
 * Suffixes to strip, longest first to avoid partial strips.
 * E.g. " football club" before " fc" so we don't leave "football ".
 */
const SUFFIXES: readonly string[] = [
  ' football club',
  ' futbol club',
  ' calcio',
  ' afc',
  ' rfc',
  ' cfc',
  ' pfc',
  ' vfc',
  ' jfc',
  ' hfc',
  ' bsc',
  ' ufc',
  ' fc',
  ' cf',
  ' sc',
  ' ac',
  ' bk',
  ' sk',
  ' fk',
  ' ik',
  ' sv',
  ' vv',
  ' sb',
  ' if',
  ' bv',
];

/** Strip non-word characters except spaces, hyphens, ampersands, apostrophes. */
const PUNCT_RE = /[^a-z0-9 &'-]/g;

/**
 * Normalise a team name for fuzzy matching.
 *
 * Steps:
 *   1. Lowercase + trim
 *   2. Strip punctuation (preserving spaces, hyphens, &, apostrophes)
 *   3. Repeatedly strip known club suffixes until stable
 *   4. Final trim
 *   5. Apply TEAM_ALIASES lookup (idempotent if no alias exists)
 *
 * Pure function — deterministic, no I/O.
 *
 * @example
 *   normalizeTeamName("Manchester United FC")  // → "manchester united"
 *   normalizeTeamName("Man Utd")               // → "manchester united" (via alias)
 *   normalizeTeamName("PSG")                   // → "paris saint-germain" (via alias)
 */
export function normalizeTeamName(raw: string): string {
  let s = raw.toLowerCase().trim().replace(PUNCT_RE, '');

  // Iteratively strip suffixes (handles "FC SC", "AFC FC" edge cases).
  let changed = true;
  while (changed) {
    changed = false;
    for (const sfx of SUFFIXES) {
      if (s.endsWith(sfx)) {
        s = s.slice(0, s.length - sfx.length).trimEnd();
        changed = true;
        break;  // restart from longest suffix
      }
    }
  }

  s = s.trim();
  return TEAM_ALIASES[s] ?? s;
}

// ── Polymarket market type ────────────────────────────────────────────────────

/**
 * Minimal Polymarket market shape needed for fixture matching and price extraction.
 * Populated from the Gamma API `/markets` endpoint.
 */
export interface PolymarketSoccerMarket {
  conditionId: string;
  question: string;
  /** Outcome labels, e.g. ["Yes","No"] or ["France","Spain"]. */
  outcomes: string[];
  /** Parallel array of prices (0–1) for each outcome. */
  outcomePrices: number[];
  endDate: Date;
  active: boolean;
  closed: boolean;
  /** Best ask for the first/YES outcome (may be undefined). */
  bestAsk?: number;
  liquidity: number;
}

// ── Match result ──────────────────────────────────────────────────────────────

/**
 * A successfully matched (fixture-outcome, Polymarket-market) pair.
 */
export interface MatchResult {
  /** Which side of the Betfair 1X2 market this corresponds to. */
  betfairSide: 'home' | 'away';
  /** The matched Polymarket market. */
  market: PolymarketSoccerMarket;
  /**
   * The Polymarket price (0–1) for the outcome that corresponds to
   * `betfairSide` winning.
   * For Yes/No markets: price of the YES outcome.
   * For named-outcome markets (["France","Spain"]): price of the relevant team.
   */
  polymarketPrice: number;
  /**
   * How the price was extracted — for audit/logging.
   * "yes_no"  = standard binary Yes/No outcome
   * "named"   = outcome array contains team names (e.g. ["France","Spain"])
   */
  matchType: 'yes_no' | 'named';
}

// ── Date window constants ─────────────────────────────────────────────────────

/**
 * Gamma market endDate must be within this window around the Betfair kickoff.
 *
 * Lower bound (6h before kickoff): catches markets that close slightly early
 *   due to timezone rounding or early-bird resolvers.
 * Upper bound (30h after kickoff): captures late-resolving markets (extra time,
 *   match abandoned → replayed) while excluding season-long tournament winner
 *   markets (e.g. "Will Spain win the World Cup?" endDate weeks away).
 */
const WINDOW_BEFORE_MS = 6  * 60 * 60 * 1000;   //  6 hours
const WINDOW_AFTER_MS  = 30 * 60 * 60 * 1000;   // 30 hours

// ── Outcome classification helpers ───────────────────────────────────────────

/** Returns true if the outcomes array is a standard Yes/No binary market. */
function isYesNoBinary(outcomes: string[]): boolean {
  if (outcomes.length !== 2) return false;
  const lo = outcomes.map((o) => o.toLowerCase());
  return lo.includes('yes') && lo.includes('no');
}

/** Returns the index of the "Yes" outcome, or -1 if not found. */
function yesIndex(outcomes: string[]): number {
  return outcomes.findIndex((o) => o.toLowerCase() === 'yes');
}

/**
 * Question-type blocklist — patterns that indicate a non-win market we should
 * skip regardless of team names present.
 *
 * Why a blocklist rather than an allowlist:
 *   Polymarket question phrasing evolves. A blocklist is easier to extend
 *   incrementally (add one entry when a new noise market type is observed)
 *   whereas an allowlist would require enumerating every valid phrasing upfront.
 *
 * All patterns are tested on the LOWERCASED question.
 *
 * Blocked patterns:
 *   exact score   — "Exact Score: France 2 - 1 Spain?"
 *   spread:       — "Spread: France (-1.5)" (named-outcome spread markets)
 *   both teams    — "Both Teams to Score"
 *   end in a draw — "Will France vs. Spain end in a draw?"
 *   halftime/half-time — "Draw at halftime?", "France leading at halftime?"
 *   o/u N.N       — "France vs. Spain: O/U 2.5"
 *   over/under    — explicit O/U phrasing
 *   advance from  — group-stage advance markets (not match winner)
 *   penalty       — penalty shootout specific markets
 *   first goal    — "Who scores the first goal?"
 *   anytime scorer
 */
const QUESTION_BLOCKLIST_RE =
  /exact\s+score|spread:|both\s+teams|end\s+in\s+a\s+draw|halftime|half.time|o\/u\s+[\d.]|over\/under|advance\s+from|penalty|first\s+goal|anytime\s+scorer/i;

/**
 * Returns true if this is a match-WIN market that we want to compare against
 * Betfair's 1X2 Home/Away odds.
 *
 * For Yes/No markets: question must contain "win" or "[team] to advance"
 *   and must NOT be in the blocklist.
 * For named-outcome markets: question must NOT be in the blocklist.
 */
function isMatchWinMarket(question: string, outcomes: string[]): boolean {
  const lo = question.toLowerCase();
  if (QUESTION_BLOCKLIST_RE.test(lo)) return false;

  if (isYesNoBinary(outcomes)) {
    // Require the question to be about winning (not draws, corners, BTTS, etc.)
    return lo.includes('win') || lo.includes('beat') || lo.includes('to advance') || lo.includes('qualify');
  }

  // Named-outcome: if it's not in the blocklist it's probably a winner market
  // (e.g. "Team to Advance", "Who wins?")
  return true;
}

// ── Matcher ───────────────────────────────────────────────────────────────────

/**
 * Match a Betfair Exchange fixture to Polymarket markets for the home and/or
 * away team winning.
 *
 * Returns 0, 1, or 2 MatchResults:
 *   - 0: no unambiguous match found for either side
 *   - 1: one side matched
 *   - 2: both home and away sides matched (from the same or different markets)
 *
 * When more than one Polymarket market satisfies the criteria for a single
 * side (ambiguous), that side returns no result and the candidates are passed
 * to `onAmbiguous` for logging — we do NOT guess.
 *
 * @param fixture   - Betfair fixture (OddsPapi shape)
 * @param markets   - Pre-fetched active Polymarket soccer markets
 * @param onAmbiguous - Called when >1 candidate matches a single side; receives
 *                      the side label and all candidate markets so they can be
 *                      logged externally. Optional.
 */
export function matchFixtureToPolymarketMarket(
  fixture: {
    fixtureId: string;
    participant1Name: string;  // home team
    participant2Name: string;  // away team
    startTime: string;
  },
  markets: PolymarketSoccerMarket[],
  onAmbiguous?: (
    fixtureId: string,
    side: 'home' | 'away',
    candidates: PolymarketSoccerMarket[],
  ) => void,
): MatchResult[] {
  const kickoffMs = new Date(fixture.startTime).getTime();
  const normP1    = normalizeTeamName(fixture.participant1Name);
  const normP2    = normalizeTeamName(fixture.participant2Name);

  // Collect home/away candidates separately so we can detect ambiguity per side.
  const homeCandidates: MatchResult[] = [];
  const awayCandidates: MatchResult[] = [];

  for (const market of markets) {
    if (!market.active || market.closed) continue;

    // ── Date window ────────────────────────────────────────────────────────
    const endMs  = market.endDate.getTime();
    const loMs   = kickoffMs - WINDOW_BEFORE_MS;
    const hiMs   = kickoffMs + WINDOW_AFTER_MS;
    if (endMs < loMs || endMs > hiMs) continue;

    const normQ = market.question.toLowerCase().replace(PUNCT_RE, '');

    // ── Question-type filter: skip non-win markets (exact scores, spreads, etc.)
    if (!isMatchWinMarket(market.question, market.outcomes)) continue;

    // ── Case C: Named-outcome head-to-head ("France vs. Spain: Team to Advance")
    // Outcome array contains both team names instead of Yes/No.
    // Skip O/U, Spread, etc. by requiring team names in outcomes.
    if (!isYesNoBinary(market.outcomes)) {
      const normOutcomes = market.outcomes.map((o) => normalizeTeamName(o));
      const p1Idx = normOutcomes.indexOf(normP1);
      const p2Idx = normOutcomes.indexOf(normP2);

      if (p1Idx !== -1 && p2Idx !== -1) {
        // Both teams found in outcomes — this is a head-to-head "who advances" market.
        // Price for home = outcomePrices[p1Idx]; price for away = outcomePrices[p2Idx].
        const p1Price = market.outcomePrices[p1Idx];
        const p2Price = market.outcomePrices[p2Idx];
        if (p1Price != null && p1Price > 0) {
          homeCandidates.push({
            betfairSide:     'home',
            market,
            polymarketPrice: p1Price,
            matchType:       'named',
          });
        }
        if (p2Price != null && p2Price > 0) {
          awayCandidates.push({
            betfairSide:     'away',
            market,
            polymarketPrice: p2Price,
            matchType:       'named',
          });
        }
      }
      // Non-matching named-outcome markets (Over/Under, Spread, etc.) fall through.
      continue;
    }

    // ── Case A / B: Yes/No binary market ──────────────────────────────────
    const yIdx     = yesIndex(market.outcomes);
    const yesPrice = yIdx !== -1 ? market.outcomePrices[yIdx] : undefined;
    if (yesPrice == null || yesPrice <= 0 || yesPrice >= 1) continue;

    const containsP1 = normQ.includes(normP1);
    const containsP2 = normQ.includes(normP2);

    if (containsP1 && containsP2) {
      // Case B: both teams in question — assign side by position.
      // The team that appears first in the question is the "winner if YES" subject.
      const p1Pos = normQ.indexOf(normP1);
      const p2Pos = normQ.indexOf(normP2);
      if (p1Pos <= p2Pos) {
        homeCandidates.push({ betfairSide: 'home', market, polymarketPrice: yesPrice, matchType: 'yes_no' });
      } else {
        awayCandidates.push({ betfairSide: 'away', market, polymarketPrice: yesPrice, matchType: 'yes_no' });
      }
    } else if (containsP1 && !containsP2) {
      // Case A: single-team, home — "Will [P1] win?"
      homeCandidates.push({ betfairSide: 'home', market, polymarketPrice: yesPrice, matchType: 'yes_no' });
    } else if (containsP2 && !containsP1) {
      // Case A: single-team, away — "Will [P2] win?"
      awayCandidates.push({ betfairSide: 'away', market, polymarketPrice: yesPrice, matchType: 'yes_no' });
    }
    // If neither team appears in the question, skip (unrelated Yes/No market).
  }

  const results: MatchResult[] = [];

  // Home side: unambiguous only if exactly one candidate.
  if (homeCandidates.length === 1) {
    results.push(homeCandidates[0]!);
  } else if (homeCandidates.length > 1) {
    onAmbiguous?.(fixture.fixtureId, 'home', homeCandidates.map((c) => c.market));
  }

  // Away side: same logic.
  if (awayCandidates.length === 1) {
    results.push(awayCandidates[0]!);
  } else if (awayCandidates.length > 1) {
    onAmbiguous?.(fixture.fixtureId, 'away', awayCandidates.map((c) => c.market));
  }

  return results;
}
