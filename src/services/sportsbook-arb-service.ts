/**
 * Sportsbook-vs-Polymarket Value Betting Service
 *
 * 赛事赔率套利服务 — detection-only
 *
 * Polls OddsPapi for upcoming sports fixtures, fetches Pinnacle and Polymarket
 * odds in a single request (OddsPapi includes Polymarket as a native bookmaker
 * slug — no cross-system event matching required), de-vigs Pinnacle's line to
 * a fair probability, and emits a 'signal' event when the edge vs Polymarket's
 * YES price clears both minEdge and minNetProfitUSD thresholds after fees.
 *
 * ⚠️  DIRECTIONAL BET — NOT RISK-FREE ARBITRAGE.
 * Signals represent expected-value opportunities, not locked-in profits.
 * The underlying event can still resolve against the bet. Treat these signals
 * with a lower confidence level than NegRiskArbService or LogicArbService.
 *
 * OddsPapi authentication: ?apiKey=YOUR_KEY query parameter (no OAuth/headers).
 * Base URL: https://api.oddspapi.io/v4
 *
 * Fee note: SportsbookArbService uses SPORTS_FEE_RATE (0.05) as a fixed fee
 * because OddsPapi's Polymarket data does not include a conditionId, making
 * per-market CLOB fee resolution impractical at this stage.
 *
 * Events emitted:
 *   'started'  — service began polling
 *   'scanned'  — one scan cycle completed (SportsbookArbScanResult payload)
 *   'signal'   — value-bet opportunity found (SportsbookArbSignal payload)
 *   'stopped'  — service stopped cleanly
 *   'error'    — Error payload; caller should decide whether to restart
 *
 * Usage:
 *   const svc = new SportsbookArbService('your-oddspapi-key');
 *   svc.on('signal', sig => console.log(sig));
 *   await svc.start();
 */

import { EventEmitter } from 'events';
import {
  SPORTS_FEE_RATE,
  devigOddsToProbability,
  netProfitValueBet,
  overroundToConfidence,
  pinnacleOverround,
  type SportsbookArbConfig,
  type SportsbookArbLeg,
  type SportsbookArbScanResult,
  type SportsbookArbSignal,
} from './sportsbook-arb-types.js';

// ============= OddsPapi API types =============

/** Minimal fixture shape from GET /v4/fixtures */
interface OddspapiFixture {
  fixtureId: string;
  participant1Name: string;
  participant2Name: string;
  participant1Id: number;
  participant2Id: number;
  startTime: string;
  sportId: number;
  sportName: string;
  tournamentId: number;
  tournamentName: string;
  categoryName: string;
  statusId: number;
  statusName: string;
  hasOdds: boolean;
}

/** Fixtures endpoint response envelope (may be array or object). */
type OddspapiFixturesResponse = OddspapiFixture[] | { fixtures: OddspapiFixture[] };

/** Single outcome from GET /v4/odds */
interface OddspapiOutcome {
  price?: number;          // decimal odds (Pinnacle) OR 1/cents (Polymarket auto-converted)
  priceAmerican?: string;
  active?: boolean;
  limit?: number;
  exchangeMeta?: {
    back: Array<{ cents: number; price: number; size: number; limit: number }>;
    lay:  Array<unknown>;
    bookmakerLayOutcomeId?: string;
    bookmakerOutcomeId?:    string;
  };
}

/** Single market from bookmaker data */
interface OddspapiMarket {
  outcomes: Record<string, OddspapiOutcome | undefined>;
}

/** Per-bookmaker odds block */
interface OddspapiBookmaker {
  markets: Record<string, OddspapiMarket | undefined>;
}

/** Odds endpoint response */
interface OddspapiOddsResponse {
  bookmakerOdds?: Record<string, OddspapiBookmaker | undefined>;
}

// ============= Constants =============

const ODDSPAPI_BASE  = 'https://api.oddspapi.io/v4';
const PINNACLE_SLUG  = 'pinnacle';
const POLYMARKET_SLUG = 'polymarket';

const DEFAULT_CONFIG: SportsbookArbConfig = {
  sportIds:       [7, 10],      // 7 = Basketball (NBA), 10 = Soccer
  lookaheadDays:  3,
  scanIntervalMs: 300_000,      // 5 minutes
  minEdge:        0.05,         // 5 percentage points minimum
  minNetProfitUSD: 0.05,
  shares:         10,
  feeRate:        SPORTS_FEE_RATE,
};

// ============= Service =============

export class SportsbookArbService extends EventEmitter {
  private cfg: SportsbookArbConfig = { ...DEFAULT_CONFIG };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param apiKey - OddsPapi API key (passed as ?apiKey= query parameter)
   */
  constructor(private readonly apiKey: string) {
    super();
  }

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  updateConfig(partial: Partial<SportsbookArbConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  getConfig(): Readonly<SportsbookArbConfig> {
    return { ...this.cfg };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Polling loop
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // OddsPapi fetch helpers
  // --------------------------------------------------------------------------

  /** Builds a URL string with the apiKey query parameter appended. */
  private url(path: string, params: Record<string, string | number> = {}): string {
    const qs = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      apiKey: this.apiKey,
    });
    return `${ODDSPAPI_BASE}${path}?${qs.toString()}`;
  }

  /** Fetches upcoming fixtures for a given sport within the lookahead window. */
  private async fetchFixtures(sportId: number): Promise<OddspapiFixture[]> {
    const now     = new Date();
    const end     = new Date(now.getTime() + this.cfg.lookaheadDays * 86_400_000);
    const dateFrom = now.toISOString().slice(0, 10);
    const dateTo   = end.toISOString().slice(0, 10);

    const res = await fetch(this.url('/fixtures', { sportId, dateFrom, dateTo }));
    if (!res.ok) {
      throw new Error(`OddsPapi /fixtures failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as OddspapiFixturesResponse;

    // Response may be a bare array or { fixtures: [...] }.
    return Array.isArray(data) ? data : (data.fixtures ?? []);
  }

  /** Fetches Pinnacle + Polymarket odds for a single fixture. */
  private async fetchOdds(fixtureId: string): Promise<OddspapiOddsResponse> {
    const res = await fetch(
      this.url('/odds', {
        fixtureId,
        bookmakers: `${PINNACLE_SLUG},${POLYMARKET_SLUG}`,
      }),
    );
    if (!res.ok) {
      throw new Error(`OddsPapi /odds failed for ${fixtureId}: ${res.status}`);
    }
    return (await res.json()) as OddspapiOddsResponse;
  }

  // --------------------------------------------------------------------------
  // Core scan
  // --------------------------------------------------------------------------

  private async scan(): Promise<void> {
    let fixturesTotal       = 0;
    let fixturesWithPolymarket = 0;

    for (const sportId of this.cfg.sportIds) {
      let fixtures: OddspapiFixture[];
      try {
        fixtures = await this.fetchFixtures(sportId);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        continue;
      }

      for (const fixture of fixtures) {
        if (!fixture.hasOdds) continue;
        fixturesTotal++;

        let oddsData: OddspapiOddsResponse;
        try {
          oddsData = await this.fetchOdds(fixture.fixtureId);
        } catch {
          // Non-fatal: skip this fixture
          continue;
        }

        const bookmakers = oddsData.bookmakerOdds;
        if (!bookmakers) continue;

        const pinnacleData  = bookmakers[PINNACLE_SLUG];
        const polymarketData = bookmakers[POLYMARKET_SLUG];

        // Skip fixtures where Polymarket has no coverage (very common for sports).
        if (!pinnacleData || !polymarketData) continue;

        fixturesWithPolymarket++;

        // Iterate over each market offered by Pinnacle, look for a matching
        // Polymarket market with the same market ID.
        for (const [marketId, pinnacleMarket] of Object.entries(pinnacleData.markets)) {
          if (!pinnacleMarket) continue;

          const polyMarket = polymarketData.markets[marketId];
          if (!polyMarket) continue;

          // Collect outcome pairs: Pinnacle decimal odds + Polymarket cents price.
          // We only process markets where we have a clean pairing for ALL outcomes
          // (ensures the de-vig uses the full overround).
          const outcomeIds = Object.keys(pinnacleMarket.outcomes);

          // Need at least 2 outcomes to de-vig.
          if (outcomeIds.length < 2) continue;

          const pinnacleDecimalOdds: number[] = [];
          const polyPrices:          number[] = [];
          const outcomeNames:        string[] = [];
          const outcomeIdList:       string[] = [];

          let dataComplete = true;
          for (const outcomeId of outcomeIds) {
            const pinnacleOutcome = pinnacleMarket.outcomes[outcomeId];
            const polyOutcome     = polyMarket.outcomes[outcomeId];

            const pDecimal = pinnacleOutcome?.price;
            if (!pDecimal || pDecimal <= 1 || pinnacleOutcome?.active === false) {
              dataComplete = false;
              break;
            }

            // Polymarket price: prefer exchangeMeta.back[0].cents (the native share
            // price, already a 0–1 probability). Fall back to 1/price if missing.
            const cents = polyOutcome?.exchangeMeta?.back?.[0]?.cents;
            const pPrice = cents != null && cents > 0 && cents < 1
              ? cents
              : (polyOutcome?.price && polyOutcome.price > 1 ? 1 / polyOutcome.price : null);

            if (pPrice === null || polyOutcome?.active === false) {
              // Polymarket doesn't have this specific outcome — skip entire market.
              dataComplete = false;
              break;
            }

            pinnacleDecimalOdds.push(pDecimal);
            polyPrices.push(pPrice);
            outcomeNames.push(outcomeId);  // outcome name not in nested data; use ID as label
            outcomeIdList.push(outcomeId);
          }

          if (!dataComplete || pinnacleDecimalOdds.length < 2) continue;

          // De-vig Pinnacle to get fair probabilities.
          const fairProbs = devigOddsToProbability(pinnacleDecimalOdds);
          const overround = pinnacleOverround(pinnacleDecimalOdds);

          // Check each outcome for a value-bet edge.
          const legs: SportsbookArbLeg[] = [];

          for (let i = 0; i < fairProbs.length; i++) {
            const fairProb    = fairProbs[i]!;
            const polyPrice   = polyPrices[i]!;
            const edge        = fairProb - polyPrice;

            if (edge < this.cfg.minEdge) continue;

            const expectedNet = netProfitValueBet(
              fairProb,
              polyPrice,
              this.cfg.shares,
              this.cfg.feeRate,
            );

            if (expectedNet < this.cfg.minNetProfitUSD) continue;

            legs.push({
              outcomeName:            outcomeNames[i]!,
              pinnacleDecimalOdds:    pinnacleDecimalOdds[i]!,
              fairProbability:        fairProb,
              polymarketPrice:        polyPrice,
              edge,
              expectedNetProfitUSD:   expectedNet,
            });
          }

          if (legs.length === 0) continue;

          const signal: SportsbookArbSignal = {
            fixtureId:         fixture.fixtureId,
            marketId,
            participant1Name:  fixture.participant1Name,
            participant2Name:  fixture.participant2Name,
            sportName:         fixture.sportName,
            tournamentName:    fixture.tournamentName,
            startTime:         fixture.startTime,
            legs,
            pinnacleOverround: overround,
            confidence:        overroundToConfidence(overround),
            shares:            this.cfg.shares,
            feeRate:           this.cfg.feeRate,
          };

          this.emit('signal', signal);
        }
      }
    }

    const scanResult: SportsbookArbScanResult = {
      fixturesTotal,
      fixturesWithPolymarket,
      scannedAt: Date.now(),
    };
    this.emit('scanned', scanResult);
  }
}
