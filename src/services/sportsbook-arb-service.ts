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
 *   1. Refresh fixture list from OddsPapi /fixtures every 3 hours (cheap call).
 *   2. Classify each fixture into a tier: 'live' | 'pregame' | 'skip'.
 *   3. Every minute: fetch /odds ONLY for fixtures that are due based on tier.
 *      - Live fixtures: poll every liveOddsIntervalMs (1 min).
 *      - Pregame fixtures (kickoff within 24h): poll every pregameOddsIntervalMs (30 min).
 *      - Everything else: skip entirely.
 *   4. Fetch all active Polymarket markets from the Gamma API (cached 5 min).
 *   5. For each polled fixture, run matchFixtureToPolymarketMarket() — normalised
 *      team names + date window must both satisfy.
 *   6. On a match: get conditionId from Gamma, then token_id from CLOB.
 *   7. Compute fair probability from Betfair Exchange MID-PRICE.
 *   8. Emit 'signal' when edge clears minEdge and minNetProfitUSD thresholds.
 *
 * ── Tiered polling quota math ─────────────────────────────────────────────────
 *
 * Previous design: 200 fixtures × 1 scan/min × 60 × 24 = 288,000 /odds calls/day.
 * Tiered design (example with 20 live + 30 pregame fixtures):
 *   /fixtures:  2 sportIds × 8 refreshes/day   =    16 calls/day
 *   /odds live: 20 fixtures × 60 × 24           = 28,800 calls/day   ← only during live windows
 *   /odds pre:  30 fixtures × 2 calls/day        =    60 calls/day
 *   Total ≈ 28,876/day (vs 288,000) — ~10× reduction; stays within 3,000/month quota.
 *
 * (Real numbers will be much lower because live fixtures only exist for ~2h each.)
 *
 * ── OddsPapi request accounting ───────────────────────────────────────────────
 *
 * Both /fixtures and /odds calls are counted against monthlyQuota. 429 responses
 * are NOT counted (server rejected before consuming quota). At quotaWarningThreshold
 * (90%), /odds polling halts with a warning; /fixtures calls continue.
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
 * ── OddsPapi outcome ID convention (assumed, not officially documented) ────────
 *
 * For Market 101 (1X2):
 *   outcomeId "101" = Home Win (participant1 / fixture.participant1Name)
 *   outcomeId "102" = Draw
 *   outcomeId "103" = Away Win (participant2 / fixture.participant2Name)
 *
 * ── Events emitted ─────────────────────────────────────────────────────────────
 *   'started'  — service began polling
 *   'scanned'  — one odds-check cycle completed (SportsbookArbScanResult payload)
 *   'signal'   — value-bet opportunity found (SportsbookArbSignal payload)
 *   'stopped'  — service stopped cleanly
 *   'error'    — Error payload; caller should decide whether to restart
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../modules/shared/logger.js';
import {
	SPORTS_FEE_RATE,
	exchangeSpreadToConfidence,
	midPriceFairProbability,
	netProfitValueBet,
	type FixtureTier,
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

const log = createLogger('sportsbook-arb');

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

// ── Pure exports (used by tests and bot/index.ts) ─────────────────────────────

/**
 * OddsPapi statusIds that indicate a match is currently live.
 * In Practice (2), Half Time (3), Extra Time (4), Break (5), Penalties (6).
 */
export const DEFAULT_LIVE_STATUS_IDS: readonly number[] = [2, 3, 4, 5, 6];

/**
 * How long to treat a fixture as potentially in-play after kickoff when
 * statusId hasn't been updated yet (90 min + 30 min ET + 30 min buffer = 2.5h).
 */
const MATCH_DURATION_MS = 2.5 * 60 * 60 * 1000;

/**
 * Classify a fixture into a polling tier.
 *
 * Priority order:
 *   1. hasOdds=false → 'skip'
 *   2. statusId in liveStatusIds → 'live'
 *   3. kickoff was < MATCH_DURATION_MS ago (statusId lag) → 'live'
 *   4. kickoff was ≥ MATCH_DURATION_MS ago (finished) → 'skip'
 *   5. kickoff within pregameWindowMs → 'pregame'
 *   6. everything else (far future) → 'skip'
 *
 * This is a pure function — no I/O, deterministic, unit-testable.
 */
export function classifyFixture(
	fixture: { statusId: number; startTime: string; hasOdds: boolean },
	nowMs: number,
	liveStatusIds: readonly number[],
	pregameWindowMs: number,
): FixtureTier {
	if (!fixture.hasOdds) return 'skip';
	if (liveStatusIds.includes(fixture.statusId)) return 'live';
	const kickoffMs = new Date(fixture.startTime).getTime();
	const msUntilKickoff = kickoffMs - nowMs;
	// Kicked off but statusId not yet updated by OddsPapi → treat as live
	if (msUntilKickoff < 0 && msUntilKickoff > -MATCH_DURATION_MS) return 'live';
	// Clearly finished (kickoff was ≥ MATCH_DURATION_MS ago)
	if (msUntilKickoff <= -MATCH_DURATION_MS) return 'skip';
	// Pregame: kickoff within window
	if (msUntilKickoff <= pregameWindowMs) return 'pregame';
	return 'skip';
}

// ── Module-level UTC helpers (not exported) ───────────────────────────────────

function utcDayStart(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcMonthStart(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function isDifferentUtcMonth(nowMs: number, monthStartMs: number): boolean {
	const n = new Date(nowMs);
	const m = new Date(monthStartMs);
	return n.getUTCFullYear() !== m.getUTCFullYear() || n.getUTCMonth() !== m.getUTCMonth();
}

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SportsbookArbConfig = {
	sportIds:                  [10],       // 10 = Soccer
	lookaheadDays:             3,
	minEdge:                   0.05,       // 5 percentage points minimum
	minNetProfitUSD:           0.05,
	shares:                    10,
	feeRate:                   SPORTS_FEE_RATE,
	liveStatusIds:             DEFAULT_LIVE_STATUS_IDS,
	fixtureRefreshIntervalMs:  3 * 60 * 60 * 1000,  // 3 hours
	liveOddsIntervalMs:        60_000,               // 1 minute
	pregameOddsIntervalMs:     30 * 60_000,          // 30 minutes
	pregameWindowMs:           24 * 60 * 60 * 1000,  // 24 hours
	monthlyQuota:              3_000,
	quotaWarningThreshold:     0.9,
};

// ── Service ───────────────────────────────────────────────────────────────────

export class SportsbookArbService extends EventEmitter {
	private cfg: SportsbookArbConfig = { ...DEFAULT_CONFIG };
	private running = false;

	// Two separate timers
	private fixtureRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private oddsCheckTimer: ReturnType<typeof setTimeout> | null = null;

	// Cached fixtures from the last /fixtures call, keyed by fixtureId
	private fixtureCache: Map<string, OddspapiFixture> = new Map();
	private fixtureCacheFetchedAt = 0;

	// Per-fixture tracking: when we last fetched /odds for this fixtureId
	private lastOddsPolledAt: Map<string, number> = new Map();

	// Cached Polymarket markets (Gamma API, existing 5-min TTL)
	private gammaCache: { markets: PolymarketSoccerMarket[]; fetchedAt: number } | null = null;

	// Request counters (reset on UTC day/month boundary)
	private requestsToday = 0;
	private requestsThisMonth = 0;
	private dayStart = utcDayStart(Date.now());
	private monthStart = utcMonthStart(Date.now());

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

		this.startFixtureRefreshLoop();
		this.startOddsCheckLoop();
	}

	stop(): void {
		this.running = false;
		if (this.fixtureRefreshTimer !== null) {
			clearTimeout(this.fixtureRefreshTimer);
			this.fixtureRefreshTimer = null;
		}
		if (this.oddsCheckTimer !== null) {
			clearTimeout(this.oddsCheckTimer);
			this.oddsCheckTimer = null;
		}
		this.emit('stopped');
	}

	// ── Request counter helpers ───────────────────────────────────────────────

	private tickRequest(): void {
		const now = Date.now();
		if (now >= this.dayStart + 86_400_000) {
			this.requestsToday = 0;
			this.dayStart = utcDayStart(now);
		}
		if (isDifferentUtcMonth(now, this.monthStart)) {
			this.requestsThisMonth = 0;
			this.monthStart = utcMonthStart(now);
		}
		this.requestsToday++;
		this.requestsThisMonth++;
	}

	private isNearQuota(): boolean {
		return this.requestsThisMonth >= this.cfg.monthlyQuota * this.cfg.quotaWarningThreshold;
	}

	// ── Fixture refresh loop ──────────────────────────────────────────────────

	private startFixtureRefreshLoop(): void {
		const runRefresh = async (): Promise<void> => {
			if (!this.running) return;
			try {
				await this.refreshFixtures();
			} catch (err) {
				this.emit('error', err instanceof Error ? err : new Error(String(err)));
			}
			if (!this.running) return;
			this.fixtureRefreshTimer = setTimeout(runRefresh, this.cfg.fixtureRefreshIntervalMs);
		};

		void runRefresh();
	}

	/**
	 * Refresh the fixture cache from OddsPapi /fixtures for all configured sportIds.
	 * This is a cheap call (one per sportId) that tells us what's upcoming/live.
	 * /fixtures calls count against quota too; 429 halts the refresh for this cycle.
	 */
	private async refreshFixtures(): Promise<void> {
		for (const sportId of this.cfg.sportIds) {
			let fixtures: OddspapiFixture[];
			try {
				fixtures = await this.fetchFixtures(sportId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('429')) {
					log.warn('OddsPapi /fixtures 429 — skipping fixture refresh for this cycle', { sportId });
					return;
				}
				this.emit('error', err instanceof Error ? err : new Error(msg));
				continue;
			}

			for (const fixture of fixtures) {
				this.fixtureCache.set(fixture.fixtureId, fixture);
			}
		}
		this.fixtureCacheFetchedAt = Date.now();
		log.debug('Fixture cache refreshed', { fixtureCount: this.fixtureCache.size });
	}

	// ── Odds check loop ───────────────────────────────────────────────────────

	private startOddsCheckLoop(): void {
		const runCheck = async (): Promise<void> => {
			if (!this.running) return;
			try {
				await this.checkOdds();
			} catch (err) {
				this.emit('error', err instanceof Error ? err : new Error(String(err)));
			}
			if (!this.running) return;
			this.oddsCheckTimer = setTimeout(runCheck, this.cfg.liveOddsIntervalMs);
		};

		void runCheck();
	}

	/**
	 * One odds-check cycle: classify all cached fixtures, poll /odds for those
	 * that are due based on their tier, match to Polymarket, emit signals.
	 * Replaces the old flat-scan approach with tiered per-fixture scheduling.
	 */
	private async checkOdds(): Promise<void> {
		// Fetch Gamma markets (cached 5 min — free API, no quota concerns).
		let gammaMarkets: PolymarketSoccerMarket[];
		try {
			gammaMarkets = await this.fetchGammaMarkets();
		} catch (err) {
			this.emit('error', err instanceof Error ? err : new Error(String(err)));
			return;
		}

		let fixturesLive              = 0;
		let fixturesPregame           = 0;
		let fixturesMatchedToPolymarket = 0;
		const now = Date.now();

		for (const [id, fixture] of this.fixtureCache) {
			const tier = classifyFixture(fixture, now, this.cfg.liveStatusIds, this.cfg.pregameWindowMs);

			if (tier === 'live') {
				fixturesLive++;
			} else if (tier === 'pregame') {
				fixturesPregame++;
			} else {
				continue;  // skip entirely
			}

			// Check if this fixture is due for an /odds poll based on its tier interval.
			const pollInterval = tier === 'live' ? this.cfg.liveOddsIntervalMs : this.cfg.pregameOddsIntervalMs;
			const lastPoll = this.lastOddsPolledAt.get(id) ?? 0;
			if (now - lastPoll < pollInterval) continue;  // not due yet

			// Halt /odds polling if near monthly quota (but continue the loop to count tiers).
			if (this.isNearQuota()) {
				log.warn('Near OddsPapi monthly quota ceiling — halting /odds polling', {
					requestsToday:    this.requestsToday,
					requestsThisMonth: this.requestsThisMonth,
					monthlyQuota:     this.cfg.monthlyQuota,
					threshold:        this.cfg.quotaWarningThreshold,
				});
				break;
			}

			// Fetch Betfair Exchange odds for this fixture.
			let oddsData: OddspapiOddsResponse;
			try {
				oddsData = await this.fetchBetfairOdds(fixture.fixtureId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('429')) {
					log.warn('OddsPapi /odds 429 — skipping remainder of odds cycle');
					break;
				}
				// Non-fatal: skip this fixture
				continue;
			}

			this.lastOddsPolledAt.set(id, now);

			const betfairBook = oddsData.bookmakerOdds?.[BETFAIR_SLUG];
			if (!betfairBook) continue;

			const market1x2 = betfairBook.markets?.[MARKET_1X2];
			if (!market1x2) continue;

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

				log.debug('[CONVENTION-CHECK]', {
					home:      fixture.participant1Name,
					away:      fixture.participant2Name,
					homeFair:  homeFair != null ? `${(homeFair * 100).toFixed(1)}%` : 'n/a',
					awayFair:  awayFair != null ? `${(awayFair * 100).toFixed(1)}%` : 'n/a',
					betfairFav,
					tier,
				});
			}

			// ── Match to Polymarket markets ──────────────────────────────────────
			const matchResults = matchFixtureToPolymarketMarket(
				fixture,
				gammaMarkets,
				(fixtureId, side, candidates) => {
					log.info('Ambiguous Polymarket match — skipping side', {
						fixtureId,
						side,
						candidates: candidates.map((c) => ({
							question:    c.question,
							conditionId: c.conditionId.slice(0, 12) + '…',
						})),
					});
				},
			);

			if (matchResults.length === 0) {
				// Debug-level: expected for most lower-division fixtures. Useful only
				// when investigating alias gaps for major leagues.
				log.debug('No Polymarket match for fixture', {
					home:       normalizeTeamName(fixture.participant1Name),
					away:       normalizeTeamName(fixture.participant2Name),
					tournament: fixture.tournamentName,
				});
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

		const quotaNearCeiling = this.isNearQuota();

		const scanResult: SportsbookArbScanResult = {
			fixturesTotal:              this.fixtureCache.size,
			fixturesLive,
			fixturesPregame,
			fixturesMatchedToPolymarket,
			requestsToday:              this.requestsToday,
			requestsThisMonth:          this.requestsThisMonth,
			monthlyQuota:               this.cfg.monthlyQuota,
			quotaNearCeiling,
			scannedAt:                  Date.now(),
		};
		this.emit('scanned', scanResult);
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

		// 429: caller handles (do NOT count against quota — server rejected it)
		if (res.status === 429) {
			throw new Error(`OddsPapi /fixtures 429 rate-limited for sportId=${sportId}`);
		}
		if (!res.ok) {
			throw new Error(`OddsPapi /fixtures failed: ${res.status} ${res.statusText}`);
		}
		// Count only non-429 responses
		this.tickRequest();

		const data = (await res.json()) as OddspapiFixturesResponse;
		return Array.isArray(data) ? data : (data.fixtures ?? []);
	}

	/** Fetch Betfair Exchange odds only — polymarket bookmaker removed. */
	private async fetchBetfairOdds(fixtureId: string): Promise<OddspapiOddsResponse> {
		const res = await fetch(
			this.url('/odds', { fixtureId, bookmakers: BETFAIR_SLUG }),
		);

		// 429: caller handles (do NOT count against quota — server rejected it)
		if (res.status === 429) {
			throw new Error(`OddsPapi /odds 429 rate-limited for fixtureId=${fixtureId}`);
		}
		if (!res.ok) {
			throw new Error(`OddsPapi /odds failed for ${fixtureId}: ${res.status}`);
		}
		// Count only non-429 responses
		this.tickRequest();

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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
	if (Array.isArray(value)) return value as T[];
	if (typeof value === 'string') {
		try { return JSON.parse(value) as T[]; } catch { return fallback; }
	}
	return fallback;
}
