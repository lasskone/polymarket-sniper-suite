/**
 * Sportsbook-vs-Polymarket Value Betting Service (Betfair Exchange edition)
 *
 * ── Architecture ───────────────────────────────────────────────────────────────
 *
 * Reference bookmaker : Betfair Exchange (betfair-ex) via OddsPapi
 * Prediction market   : Polymarket, fetched DIRECTLY from Gamma API
 *
 * Polymarket data no longer comes through OddsPapi (polymarket bookmaker slug
 * was RESTRICTED_ACCESS and its bookmakerOutcomeId was never verified). Instead:
 *   1. Fetch Betfair Exchange odds per fixture via OddsPapi (?bookmakers=betfair-ex)
 *   2. Fetch all active Polymarket markets from the Gamma API (cached 5 min)
 *   3. For each fixture, run matchFixtureToPolymarketMarket() — normalised team
 *      names + date window must both satisfy
 *   4. On a match: get conditionId from Gamma, then token_id from CLOB
 *      GET /markets/{conditionId} → tokens[outcome="Yes"].token_id
 *   5. Compute fair probability from Betfair Exchange MID-PRICE (not overround
 *      de-vig — exchanges don't have baked-in margin, see sportsbook-arb-types.ts)
 *   6. Emit 'signal' when edge clears minEdge and minNetProfitUSD thresholds
 *
 * ── OddsPapi request accounting ───────────────────────────────────────────────
 *
 * vs. previous architecture (betfair-ex + polymarket bookmakers per call):
 *   - Removed `polymarket` bookmaker from each /odds call → one bookmaker
 *     fetched per fixture instead of two. If OddsPapi counts per-bookmaker
 *     rather than per-call, this halves the odds-endpoint request cost.
 *   - Added one Gamma API fetch per scan cycle (cached 5 min) and one CLOB
 *     fetch per matched fixture (to resolve token_id). Both Gamma and CLOB are
 *     unauthenticated public APIs with no known hard rate limits.
 *
 * ── Betfair-ex OddsPapi outcome shape (verified 2026-07-14) ──────────────────
 *
 * Market 101 (1X2 Match Odds) outcomes observed (Linlithgow Rose vs St.Johnstone):
 *   outcomeId 101 → Home Win  (heavy underdog at 16.5)
 *   outcomeId 102 → Draw      (9.4)
 *   outcomeId 103 → Away Win  (heavy favourite at 1.17)
 *
 * Each outcome value is NOT a flat {price, active} object — it is nested:
 *   outcome = {
 *     players: {
 *       "0": {
 *         active: boolean
 *         price: number          ← best back price (decimal odds)
 *         bookmakerOutcomeId: string  ← Betfair Selection ID (NOT Polymarket token)
 *         exchangeMeta: {
 *           availableToBack: Array<{price, size}>   ← back ladder
 *           availableToLay:  Array<{price, size}>   ← lay ladder
 *         }
 *       }
 *     }
 *   }
 *
 * The old code read outcome?.price directly — this was always undefined.
 *
 * ── OddsPapi outcome ID convention (assumed, not officially documented) ────────
 *
 * For Market 101 (1X2):
 *   outcomeId "101" = Home Win (participant1 / fixture.participant1Name)
 *   outcomeId "102" = Draw
 *   outcomeId "103" = Away Win (participant2 / fixture.participant2Name)
 *
 * This is derived from two real-API observations (2026-07-14) and is a
 * reasonable assumption for the OddsPapi standard. If signals appear with
 * inverted home/away probabilities, swap the mapping here.
 *
 * ── Events emitted ─────────────────────────────────────────────────────────────
 *   'started'  — service began polling
 *   'scanned'  — one scan cycle completed (SportsbookArbScanResult payload)
 *   'signal'   — value-bet opportunity found (SportsbookArbSignal payload)
 *   'stopped'  — service stopped cleanly
 *   'error'    — Error payload; caller should decide whether to restart
 */

import { EventEmitter } from 'events';
import {
  SPORTS_FEE_RATE,
  exchangeSpreadToConfidence,
  midPriceFairProbability,
  netProfitValueBet,
  type SportsbookArbConfig,
  type SportsbookArbLeg,
  type SportsbookArbScanResult,
  type SportsbookArbSignal,
} from './sportsbook-arb-types.js';
import {
  matchFixtureToPolymarketMarket,
  normalizeTeamName,
  type PolymarketSoccerMarket,
} from './sportsbook-arb-matcher.js';

// ── OddsPapi type definitions ─────────────────────────────────────────────────

/** A single Betfair Exchange player/outcome entry (nested under players["0"]). */
interface BetfairPlayer {
  active:              boolean;
  price:               number;   // best back price
  bookmakerOutcomeId?: string;   // Betfair Selection ID (not Polymarket token)
  exchangeMeta?: {
    availableToBack: Array<{ price: number; size: number }>;
    availableToLay:  Array<{ price: number; size: number }>;
  };
}

/** The shape of a single outcome value in betfair-ex market.outcomes[id]. */
interface BetfairOutcomeValue {
  players?: Record<string, BetfairPlayer | undefined>;
}

interface OddspapiFixture {
  fixtureId:         string;
  participant1Name:  string;
  participant2Name:  string;
  startTime:         string;
  sportId:           number;
  sportName:         string;
  tournamentId:      number;
  tournamentName:    string;
  categoryName:      string;
  statusId:          number;
  statusName:        string;
  hasOdds:           boolean;
}

type OddspapiFixturesResponse = OddspapiFixture[] | { fixtures: OddspapiFixture[] };

interface OddspapiMarket {
  outcomes: Record<string, BetfairOutcomeValue | undefined>;
}

interface OddspapiBetfairBookmaker {
  markets: Record<string, OddspapiMarket | undefined>;
}

interface OddspapiOddsResponse {
  bookmakerOdds?: Record<string, OddspapiBetfairBookmaker | undefined>;
}

// ── Gamma / CLOB types ────────────────────────────────────────────────────────

/** Raw Gamma /markets response shape (only fields we use). */
interface GammaMarketRaw {
  conditionId:   string;
  question:      string;
  outcomes:      string | string[];     // may be JSON string or parsed array
  outcomePrices: string | number[];     // may be JSON string or parsed array
  endDate:       string;
  active:        boolean;
  closed:        boolean;
  bestAsk?:      number;
  liquidity?:    number;
}

/** CLOB GET /markets/{conditionId} minimal shape. */
interface ClobMarketShape {
  tokens?: Array<{ token_id: string; outcome: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ODDSPAPI_BASE  = 'https://api.oddspapi.io/v4';
const GAMMA_BASE     = 'https://gamma-api.polymarket.com';
const CLOB_BASE      = 'https://clob.polymarket.com';
const BETFAIR_SLUG   = 'betfair-ex';

/**
 * OddsPapi 1X2 outcome ID → home/away/draw mapping.
 * Derived from two real-API observations on 2026-07-14.
 * "draw" is excluded from value-betting (no comparable Polymarket market).
 */
const BETFAIR_1X2_OUTCOME: Record<string, 'home' | 'away' | 'draw'> = {
  '101': 'home',
  '102': 'draw',
  '103': 'away',
};

/** Market ID for the 1X2 / Match Odds market on Betfair. */
const MARKET_1X2 = '101';

/** Gamma market cache TTL — refresh once per scan interval. */
const GAMMA_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

const DEFAULT_CONFIG: SportsbookArbConfig = {
  sportIds:         [10],       // 10 = Soccer (focus here; NBA to add later)
  lookaheadDays:    3,
  scanIntervalMs:   60_000,     // 1 minute — suitable for live match scanning
  minEdge:          0.05,       // 5 percentage points minimum
  minNetProfitUSD:  0.05,
  shares:           10,
  feeRate:          SPORTS_FEE_RATE,
};

// ── Service ───────────────────────────────────────────────────────────────────

export class SportsbookArbService extends EventEmitter {
  private cfg: SportsbookArbConfig = { ...DEFAULT_CONFIG };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Cached Polymarket soccer markets from Gamma API. */
  private gammaCache: { markets: PolymarketSoccerMarket[]; fetchedAt: number } | null = null;

  constructor(private readonly apiKey: string) {
    super();
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  updateConfig(partial: Partial<SportsbookArbConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  getConfig(): Readonly<SportsbookArbConfig> {
    return { ...this.cfg };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit('started');

    try {
      await this.scan();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('stopped');
  }

  // ── Polling loop ─────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.scan();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      this.scheduleNext();
    }, this.cfg.scanIntervalMs);
  }

  // ── OddsPapi helpers ─────────────────────────────────────────────────────────

  private url(path: string, params: Record<string, string | number> = {}): string {
    const qs = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      apiKey: this.apiKey,
    });
    return `${ODDSPAPI_BASE}${path}?${qs}`;
  }

  private async fetchFixtures(sportId: number): Promise<OddspapiFixture[]> {
    const now = new Date();
    const end = new Date(now.getTime() + this.cfg.lookaheadDays * 86_400_000);
    const from = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const to   = end.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const res = await fetch(this.url('/fixtures', { sportId, from, to }));
    if (!res.ok) {
      throw new Error(`OddsPapi /fixtures failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as OddspapiFixturesResponse;
    return Array.isArray(data) ? data : (data.fixtures ?? []);
  }

  /** Fetch Betfair Exchange odds only — polymarket bookmaker removed. */
  private async fetchBetfairOdds(fixtureId: string): Promise<OddspapiOddsResponse> {
    const res = await fetch(
      this.url('/odds', { fixtureId, bookmakers: BETFAIR_SLUG }),
    );
    if (!res.ok) {
      throw new Error(`OddsPapi /odds failed for ${fixtureId}: ${res.status}`);
    }
    return (await res.json()) as OddspapiOddsResponse;
  }

  // ── Gamma API helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch active Polymarket markets from the Gamma API.
   * Results are cached for GAMMA_CACHE_TTL_MS to avoid hammering the API
   * on every 1-minute scan cycle.
   */
  private async fetchGammaMarkets(): Promise<PolymarketSoccerMarket[]> {
    const now = Date.now();
    if (this.gammaCache && now - this.gammaCache.fetchedAt < GAMMA_CACHE_TTL_MS) {
      return this.gammaCache.markets;
    }

    // Fetch top-volume active markets. No server-side sport filter exists on
    // Gamma; team-name matching in the matcher acts as the sport filter.
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Gamma API /markets failed: ${res.status} ${res.statusText}`);
    }

    const raw = (await res.json()) as GammaMarketRaw[];
    if (!Array.isArray(raw)) return [];

    const markets: PolymarketSoccerMarket[] = raw.map((m) => ({
      conditionId:    m.conditionId ?? '',
      question:       m.question    ?? '',
      outcomes:       parseJsonArray<string>(m.outcomes, ['Yes', 'No']),
      outcomePrices:  parseJsonArray<number>(m.outcomePrices, [0.5, 0.5]).map(Number),
      endDate:        new Date(m.endDate ?? 0),
      active:         Boolean(m.active),
      closed:         Boolean(m.closed),
      bestAsk:        m.bestAsk != null ? Number(m.bestAsk) : undefined,
      liquidity:      Number(m.liquidity ?? 0),
    }));

    this.gammaCache = { markets, fetchedAt: now };
    return markets;
  }

  /**
   * Resolve the YES token_id for a Polymarket market via CLOB.
   * Returns undefined on any failure — paper trade can still be stored with
   * only conditionId; the resolver retries CLOB lookup on settlement.
   */
  private async resolveYesTokenId(conditionId: string): Promise<string | undefined> {
    try {
      const res = await fetch(
        `${CLOB_BASE}/markets/${encodeURIComponent(conditionId)}`,
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as ClobMarketShape;
      const yesToken = (data.tokens ?? []).find(
        (t) => t.outcome.toLowerCase() === 'yes',
      );
      return yesToken?.token_id;
    } catch {
      return undefined;
    }
  }

  // ── Core scan ─────────────────────────────────────────────────────────────────

  private async scan(): Promise<void> {
    // Refresh Gamma markets once per scan cycle (cached internally).
    let gammaMarkets: PolymarketSoccerMarket[];
    try {
      gammaMarkets = await this.fetchGammaMarkets();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let fixturesTotal              = 0;
    let fixturesMatchedToPolymarket = 0;

    for (const sportId of this.cfg.sportIds) {
      let fixtures: OddspapiFixture[];
      try {
        fixtures = await this.fetchFixtures(sportId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429')) return;   // rate limit — skip cycle gracefully
        this.emit('error', err instanceof Error ? err : new Error(msg));
        continue;
      }

      for (const fixture of fixtures) {
        if (!fixture.hasOdds) continue;

        // ── Fetch Betfair Exchange odds ─────────────────────────────────────
        let oddsData: OddspapiOddsResponse;
        try {
          oddsData = await this.fetchBetfairOdds(fixture.fixtureId);
        } catch {
          continue;  // non-fatal: skip this fixture
        }

        const betfairBook = oddsData.bookmakerOdds?.[BETFAIR_SLUG];
        if (!betfairBook) continue;

        const market1x2 = betfairBook.markets?.[MARKET_1X2];
        if (!market1x2) continue;

        fixturesTotal++;

        // ── Convention sanity check (outcomeId 101=home / 103=away) ──────────
        // Emitted on EVERY fixture with Betfair 1X2 odds — not gated on whether
        // Polymarket matching succeeds — so the 101/103 mapping can be verified
        // from Betfair data alone (Polymarket side shown when a clean match exists).
        //
        // What to look for:
        //   • If "home fair%" < "away fair%" AND "Poly home%" < "Poly away%"
        //     → both agree the home team is the underdog. Consistent ✓
        //   • If they DISAGREE (Betfair says home is favourite but Poly says
        //     away is favourite by a large margin) → flag as a possible flip.
        //   • Large persistent inversions across multiple fixtures indicate the
        //     101/103 mapping is wrong.
        {
          const homeOv  = market1x2.outcomes['101']?.players?.['0'];
          const awayOv  = market1x2.outcomes['103']?.players?.['0'];
          const homeFair = (homeOv?.price != null && homeOv.price > 1 &&
                            homeOv.exchangeMeta?.availableToLay?.[0]?.price != null)
            ? midPriceFairProbability(homeOv.price, homeOv.exchangeMeta.availableToLay[0]!.price)
            : undefined;
          const awayFair = (awayOv?.price != null && awayOv.price > 1 &&
                            awayOv.exchangeMeta?.availableToLay?.[0]?.price != null)
            ? midPriceFairProbability(awayOv.price, awayOv.exchangeMeta.availableToLay[0]!.price)
            : undefined;

          // Betfair-implied favourite (the side with higher fair probability).
          const betfairFav = homeFair != null && awayFair != null
            ? (homeFair >= awayFair ? fixture.participant1Name : fixture.participant2Name)
            : 'unknown';

          // Polymarket-implied favourite — only available after Gamma matching.
          // Will be set below if matchResults are resolved without ambiguity.
          this.emit(
            'error',   // 'error' channel so bot/index.ts logs it as a WARNING — not fatal
            new Error(
              `[CONVENTION-CHECK] ${fixture.participant1Name} (home/101) vs ${fixture.participant2Name} (away/103) ` +
              `| Betfair: home=${homeFair != null ? (homeFair * 100).toFixed(1) + '%' : 'n/a'} ` +
              `away=${awayFair != null ? (awayFair * 100).toFixed(1) + '%' : 'n/a'} ` +
              `→ fav=${betfairFav}`,
            ),
          );
        }

        // ── Match to Polymarket markets ──────────────────────────────────────
        const matchResults = matchFixtureToPolymarketMarket(
          fixture,
          gammaMarkets,
          (fixtureId, side, candidates) => {
            this.emit(
              'error',
              new Error(
                `SportsbookArb: ambiguous Polymarket match for fixture ${fixtureId} (${side} side). ` +
                `${candidates.length} candidates: ` +
                candidates.map((c) => `"${c.question}" [${c.conditionId.slice(0, 12)}…]`).join(' | ') +
                ' — skipping this side.',
              ),
            );
          },
        );

        if (matchResults.length === 0) {
          // Log "no match" for review — useful to catch alias gaps.
          // Only log for fixtures that likely SHOULD have a Polymarket market
          // (i.e. major leagues / known teams). We log all no-matches here;
          // the operator can filter noise from small lower-division fixtures.
          this.emit(
            'error',
            new Error(
              `SportsbookArb: no Polymarket match for "${normalizeTeamName(fixture.participant1Name)}" ` +
              `vs "${normalizeTeamName(fixture.participant2Name)}" ` +
              `(${fixture.tournamentName}) — check TEAM_ALIASES if teams are listed on Polymarket`,
            ),
          );
          continue;
        }

        fixturesMatchedToPolymarket++;

        // ── Build signal legs ────────────────────────────────────────────────
        const legs: SportsbookArbLeg[] = [];

        for (const matchResult of matchResults) {
          // Find the corresponding Betfair 1X2 outcome.
          const betfairOutcomeId = Object.entries(BETFAIR_1X2_OUTCOME).find(
            ([, side]) => side === matchResult.betfairSide,
          )?.[0];
          if (!betfairOutcomeId) continue;

          const outcomeValue = market1x2.outcomes[betfairOutcomeId];
          if (!outcomeValue) continue;

          const player = outcomeValue.players?.['0'];
          if (!player?.active) continue;

          const backPrice = player.price;
          const layPrice  = player.exchangeMeta?.availableToLay?.[0]?.price;

          if (!backPrice || backPrice <= 1 || !layPrice || layPrice <= backPrice) continue;

          // ── Mid-price fair probability (exchange-correct formula) ──────────
          const fairProb    = midPriceFairProbability(backPrice, layPrice);
          const polyPrice   = matchResult.polymarketPrice;
          const edge        = fairProb - polyPrice;

          if (edge < this.cfg.minEdge) continue;

          const expectedNet = netProfitValueBet(
            fairProb,
            polyPrice,
            this.cfg.shares,
            this.cfg.feeRate,
          );
          if (expectedNet < this.cfg.minNetProfitUSD) continue;

          // ── Resolve YES token_id via CLOB ─────────────────────────────────
          // Do this async per-match; failure is non-fatal (conditionId is enough
          // for the paper-trade-resolver to re-derive token_id on settlement).
          const tokenId = await this.resolveYesTokenId(
            matchResult.market.conditionId,
          );

          legs.push({
            outcomeName:           matchResult.betfairSide,
            betfairBackPrice:      backPrice,
            betfairLayPrice:       layPrice,
            fairProbability:       fairProb,
            polymarketConditionId: matchResult.market.conditionId,
            polymarketQuestion:    matchResult.market.question,
            polymarketPrice:       polyPrice,
            edge,
            expectedNetProfitUSD:  expectedNet,
            tokenId,
          });
        }

        if (legs.length === 0) continue;

        // Use the first leg's spread for signal-level confidence.
        const primaryLeg  = legs[0]!;
        const spread      = (primaryLeg.betfairLayPrice - primaryLeg.betfairBackPrice) /
                            ((primaryLeg.betfairBackPrice + primaryLeg.betfairLayPrice) / 2);
        const confidence  = exchangeSpreadToConfidence(
          primaryLeg.betfairBackPrice,
          primaryLeg.betfairLayPrice,
        );

        const signal: SportsbookArbSignal = {
          fixtureId:        fixture.fixtureId,
          betfairMarketId:  MARKET_1X2,
          participant1Name: fixture.participant1Name,
          participant2Name: fixture.participant2Name,
          sportName:        fixture.sportName,
          tournamentName:   fixture.tournamentName,
          startTime:        fixture.startTime,
          legs,
          betfairSpread:    spread,
          confidence,
          shares:           this.cfg.shares,
          feeRate:          this.cfg.feeRate,
        };

        this.emit('signal', signal);
      }
    }

    const scanResult: SportsbookArbScanResult = {
      fixturesTotal,
      fixturesMatchedToPolymarket,
      scannedAt: Date.now(),
    };
    this.emit('scanned', scanResult);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T[]; } catch { return fallback; }
  }
  return fallback;
}
