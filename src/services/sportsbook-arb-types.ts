/**
 * Sportsbook-vs-Polymarket Value Betting — Types and Pure Functions
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * Strategy overview
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Polymarket prices for sports outcomes are often set by a thin pool of retail
 * liquidity rather than professional market makers. When Betfair Exchange's
 * consensus mid-price implies a materially different probability than
 * Polymarket's YES price, there is a value-betting edge.
 *
 * Reference bookmaker: Betfair Exchange (betfair-ex)
 *   Betfair is a peer-to-peer exchange with near-zero margin baked into
 *   prices (commission is charged on NET WINNINGS separately, not spread into
 *   odds). The mid-price between best back and best lay is the market's
 *   consensus fair value — no overround de-vig is required.
 *
 * Polymarket prices: fetched directly from the Gamma API and matched to
 *   Betfair fixtures by normalised team name + date window. This gives us
 *   the real conditionId and token_id without relying on OddsPapi's
 *   (unverified) bookmakerOutcomeId field.
 *
 * IMPORTANT: This is a DIRECTIONAL bet, not a risk-free arbitrage.
 * The underlying event can resolve against us. The "profit" computed here is
 * an EXPECTED value (probability-weighted), not a guaranteed payout. Signals
 * from this service have an inherently lower confidence level than the locked-in
 * arbitrages produced by NegRiskArbService or LogicArbService.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * Fair probability: Exchange mid-price
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   midPrice   = (bestBackPrice + bestLayPrice) / 2
 *   fairProb   = 1 / midPrice   =   2 / (back + lay)
 *
 * Why NOT use the traditional overround de-vig formula here?
 *   Betfair Exchange back prices already reflect near-true odds — the overround
 *   from back prices alone is ~1.00–1.01 (vs 1.02–1.03 for Pinnacle). Dividing
 *   by 1.005 barely changes anything and ignores the lay side entirely. The
 *   lay price constrains fair value from ABOVE: the market consensus lies
 *   between back and lay. Mid-price captures both sides.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * Confidence: exchange spread
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   fractional spread = (layPrice − backPrice) / midPrice
 *   confidence        = clamp(1 − spread / MAX_SPREAD, 0, MAX_CONFIDENCE)
 *
 * Tighter back/lay spread → higher confidence in the mid-price. Capped at
 * MAX_CONFIDENCE (0.90) because these are always directional bets.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * Fee
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Same formula as all other bots:  fee = shares × feeRate × p × (1 − p)
 *
 * SPORTS_FEE_RATE (0.05 = 500 bps) is the conservative default for sports-
 * category markets on Polymarket. This is higher than the politics default
 * (0.04) but sports markets have been observed at various rates.
 *
 * Source: https://docs.polymarket.com/trading/fees.md — "sports markets may
 * carry a higher taker fee; always verify via the CLOB API."
 * Live rate: GET https://clob.polymarket.com/markets/{conditionId}
 *             → response.taker_base_fee (integer, basis points)
 *
 * Note: SportsbookArbService uses SPORTS_FEE_RATE as a fixed assumption.
 * The real per-market fee is now available via conditionId (resolved through
 * the Gamma match) but adding a CLOB fee lookup per scan cycle would double
 * latency. Use SPORTS_FEE_RATE conservatively.
 */

import {
  feeForLeg,
  feeRateFromBps,
  FEE_RATE_BPS_DIVISOR,
} from './negrisk-arb-types.js';

// Re-export shared fee utilities.
export { feeRateFromBps, FEE_RATE_BPS_DIVISOR };

// ============= Constants =============

/**
 * Default taker fee rate for sports-category Polymarket markets.
 * 0.05 = 500 basis points — conservative assumption; use live CLOB data if available.
 */
export const SPORTS_FEE_RATE = 0.05;

// ============= Types =============

/** Configuration for SportsbookArbService. */
export interface SportsbookArbConfig {
  /**
   * OddsPapi sport IDs to poll.
   * Common values: 10 = Soccer, 7 = Basketball (NBA).
   * Fetch the full list from GET /v4/sports.
   * @default [7, 10]
   */
  sportIds: number[];
  /**
   * How many days ahead to look for fixtures.
   * OddsPapi's /v4/fixtures accepts a max 10-day window.
   * @default 3
   */
  lookaheadDays: number;
  /** Polling interval between full scans (ms). @default 300_000 (5 minutes) */
  scanIntervalMs: number;
  /**
   * Minimum edge (fairProb − polymarketPrice) required before checking net profit.
   * Guards against signal noise on very small pricing discrepancies.
   * @default 0.05 (5 percentage points)
   */
  minEdge: number;
  /** Minimum expected net profit (USDC) to emit a signal. @default 0.05 */
  minNetProfitUSD: number;
  /** Shares to buy in expected-profit calculations. @default 10 */
  shares: number;
  /** Taker fee rate coefficient. @default SPORTS_FEE_RATE (0.05) */
  feeRate: number;
}

/** One side of a value-bet signal (the outcome being priced). */
export interface SportsbookArbLeg {
  /**
   * Which side of the Betfair 1X2 market this corresponds to.
   * "home" = participant1 (OddsPapi outcomeId 101 convention).
   * "away" = participant2 (OddsPapi outcomeId 103 convention).
   */
  outcomeName: 'home' | 'away';
  /**
   * Betfair Exchange best available back price (decimal odds > 1).
   * This is the price at which you can BACK (bet for) this outcome.
   */
  betfairBackPrice: number;
  /**
   * Betfair Exchange best available lay price (decimal odds > back price).
   * This is the price at which the market is willing to LAY (bet against).
   */
  betfairLayPrice: number;
  /**
   * Fair probability derived from the exchange mid-price.
   * Formula: 2 / (betfairBackPrice + betfairLayPrice)
   * This does NOT apply traditional overround de-vig — the exchange has
   * near-zero margin in its prices; mid-price is already fair value.
   */
  fairProbability: number;
  /**
   * Polymarket conditionId for this market, sourced from the Gamma API match.
   * Used by the paper-trade resolver to query CLOB for settlement status.
   */
  polymarketConditionId: string;
  /**
   * The full Polymarket market question that was matched to this outcome.
   * Included for logging and human review.
   */
  polymarketQuestion: string;
  /**
   * Polymarket YES price for this outcome (0–1), sourced from the Gamma API.
   * This is the ask price for buying YES tokens on Polymarket.
   */
  polymarketPrice: number;
  /**
   * Edge: fairProbability − polymarketPrice.
   * Positive = Polymarket underprices vs Betfair fair value → value bet on YES.
   * Negative = Polymarket overpriced.
   */
  edge: number;
  /**
   * Expected net profit in USDC for `shares` shares after the taker fee.
   * Formula: shares × (fairProb − polyPrice) − fee
   *
   * This is NOT a guaranteed profit — it is probability-weighted expected value.
   * The trade can lose money if the event resolves against us.
   */
  expectedNetProfitUSD: number;
  /**
   * Polymarket ERC-1155 YES token ID for this market.
   * Sourced from CLOB GET /markets/{conditionId} → tokens[outcome="Yes"].token_id.
   * Used by the paper-trade resolver to determine outcome on settlement.
   * May be undefined if the CLOB lookup failed at signal time.
   */
  tokenId?: string;
}

/**
 * Emitted by SportsbookArbService when a value-bet opportunity clears the
 * minEdge and minNetProfitUSD thresholds.
 *
 * ⚠️  DIRECTIONAL BET — NOT RISK-FREE ARBITRAGE.
 * The expectedNetProfitUSD is an expected value, not a locked-in gain.
 * Always size positions conservatively; this signal carries outcome risk.
 */
export interface SportsbookArbSignal {
  /** OddsPapi fixture ID, e.g. "id1000003969653792". */
  fixtureId: string;
  /** OddsPapi market ID containing these outcomes (e.g. "101" = 1X2). */
  betfairMarketId: string;
  /** Home team / participant 1 name (as returned by OddsPapi). */
  participant1Name: string;
  /** Away team / participant 2 name (as returned by OddsPapi). */
  participant2Name: string;
  /** Sport name (e.g. "Soccer"). */
  sportName: string;
  /** Tournament / league name. */
  tournamentName: string;
  /** Match kick-off time (ISO 8601). */
  startTime: string;
  /**
   * Value-bet legs where Polymarket underprices vs Betfair Exchange fair value.
   * Typically 1 entry; may be 2 if both home and away sides show edge.
   */
  legs: SportsbookArbLeg[];
  /**
   * Fractional back-lay spread for the primary leg's Betfair outcome.
   * Formula: (layPrice − backPrice) / midPrice
   * Smaller spread = more liquid = higher confidence in mid-price fair value.
   */
  betfairSpread: number;
  /**
   * Confidence factor (0–1). Computed from the Betfair back-lay spread:
   *   1 − spread / MAX_SPREAD, capped at MAX_CONFIDENCE (0.90).
   * Tighter spread → higher confidence in the fair probability.
   * Always directional/speculative; never reaches 1.0.
   */
  confidence: number;
  /** Number of shares used in expectedNetProfitUSD calculation. */
  shares: number;
  /** Taker fee rate applied. */
  feeRate: number;
}

/** Emitted after each scan cycle completes. */
export interface SportsbookArbScanResult {
  /** Total fixtures polled from OddsPapi with Betfair Exchange odds. */
  fixturesTotal: number;
  /**
   * Fixtures successfully matched to at least one active Polymarket market
   * via the team-name + date-window matcher. This replaces the old
   * "fixturesWithPolymarket" count — Polymarket data is now fetched directly
   * from the Gamma API rather than via OddsPapi.
   */
  fixturesMatchedToPolymarket: number;
  /** Timestamp of the scan. */
  scannedAt: number;
}

// ============= Pure Functions =============

/**
 * Fair probability from a Betfair Exchange back/lay pair.
 *
 * Exchange prices have near-zero bookmaker margin baked in; commission is
 * charged on net winnings separately. The mid-price between best back and
 * best lay is the market's consensus fair value.
 *
 * Formula: fairProb = 1 / midPrice = 2 / (backPrice + layPrice)
 *
 * Why NOT use traditional overround de-vig here:
 *   Exchange back prices sum to ≈1.00 (vs 1.02–1.03 for Pinnacle). Dividing
 *   by ≈1.005 barely changes anything and ignores the lay side. The lay price
 *   constrains fair value from above; mid-price uses both constraints.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param backPrice - Best available back price (decimal odds, must be > 1)
 * @param layPrice  - Best available lay price (decimal odds, must be > backPrice)
 * @returns Fair probability (0–1)
 * @throws Error if backPrice ≤ 1 or layPrice ≤ backPrice
 *
 * @example
 * // France vs Spain: France back=3.45, lay=3.75
 * midPriceFairProbability(3.45, 3.75)  // → 2/(3.45+3.75) = 0.2778 (27.8%)
 */
export function midPriceFairProbability(backPrice: number, layPrice: number): number {
  if (backPrice <= 1) {
    throw new Error(`midPriceFairProbability: backPrice must be > 1, got ${backPrice}`);
  }
  if (layPrice <= backPrice) {
    throw new Error(
      `midPriceFairProbability: layPrice (${layPrice}) must be > backPrice (${backPrice})`,
    );
  }
  return 2 / (backPrice + layPrice);
}

/**
 * Confidence score (0–MAX_CONFIDENCE) based on the Betfair Exchange back/lay
 * fractional spread for a single outcome.
 *
 * Formula:
 *   spread     = (layPrice − backPrice) / midPrice   (fractional, always > 0)
 *   confidence = clamp(1 − spread / MAX_SPREAD, 0, MAX_CONFIDENCE)
 *
 * Tighter spread → higher market liquidity → more reliable mid-price fair value.
 * MAX_SPREAD (10% fractional) = lower bound; any spread above this signals very
 * thin liquidity, confidence = 0.
 *
 * Always capped at MAX_CONFIDENCE (0.90) — directional bets never reach full
 * confidence regardless of how liquid the exchange market is.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @example
 * // Tight liquid market: back=1.17, lay=1.20 → spread≈2.5% → high confidence
 * exchangeSpreadToConfidence(1.17, 1.20)  // → ~0.75
 *
 * // Wide illiquid market: back=10.0, lay=12.0 → spread≈18% → confidence=0
 * exchangeSpreadToConfidence(10.0, 12.0)  // → 0
 */
const MAX_SPREAD     = 0.10;  // 10% fractional spread = zero confidence threshold
const MAX_CONFIDENCE = 0.90;  // directional bets never reach 100% confidence

export function exchangeSpreadToConfidence(backPrice: number, layPrice: number): number {
  const mid      = (backPrice + layPrice) / 2;
  const spread   = (layPrice - backPrice) / mid;
  const raw      = 1 - spread / MAX_SPREAD;
  return Math.min(MAX_CONFIDENCE, Math.max(0, raw));
}

// ── Legacy functions retained for backward compatibility ──────────────────────
// These were designed for traditional bookmakers with vig baked into odds
// (e.g. Pinnacle). They are NOT used for Betfair Exchange prices.
// Kept because they have existing unit tests and may be reused if a
// traditional-bookmaker reference is ever added back.

/**
 * Converts decimal odds for multiple outcomes to fair (de-vigged) probabilities
 * using the multiplicative (proportional) method.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param decimalOdds - Array of decimal odds for each outcome (must be > 1.0)
 * @returns Array of fair probabilities (same order; sums to 1.0)
 * @throws Error if any odds value is ≤ 1 or the array is empty
 *
 * @example
 * // Balanced coin-flip equivalent
 * devigOddsToProbability([2.0, 2.0])   // → [0.5, 0.5]
 *
 * // NBA moneyline with typical Pinnacle margin
 * devigOddsToProbability([1.83, 2.05])
 * // raw: [0.5464, 0.4878] → overround = 1.0342 → fair: [0.528, 0.472]
 *
 * @example
 * // Soccer 1X2 with 3 outcomes
 * devigOddsToProbability([2.10, 3.40, 3.20])
 */
export function devigOddsToProbability(decimalOdds: readonly number[]): number[] {
  if (decimalOdds.length === 0) {
    throw new Error('devigOddsToProbability: odds array must not be empty');
  }
  for (const d of decimalOdds) {
    if (d <= 1) {
      throw new Error(`devigOddsToProbability: decimal odds must be > 1, got ${d}`);
    }
  }

  const rawProbs = decimalOdds.map(d => 1 / d);
  const overround = rawProbs.reduce((sum, p) => sum + p, 0);  // > 1 due to vig
  return rawProbs.map(rp => rp / overround);
}

/**
 * Computes the Pinnacle line's overround (sum of raw implied probabilities).
 * Overround > 1 indicates bookmaker margin. E.g. 1.022 = 2.2% margin.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param decimalOdds - Array of decimal odds for each outcome
 */
export function pinnacleOverround(decimalOdds: readonly number[]): number {
  return decimalOdds.reduce((sum, d) => sum + 1 / d, 0);
}

/**
 * Converts a Pinnacle overround into a confidence score (0–1) for the de-vigged
 * fair probability.
 *
 * Formula: confidence = clamp(1 − (overround − 1) / MAX_OVERROUND_EXCESS, 0, 1)
 *
 * Pinnacle's overround is typically 1.015–1.030 (1.5–3%). Markets with higher
 * overround (>3%) are less liquid and the fair probability is less reliable.
 *
 * Since this is always a directional bet, confidence is capped at 0.90.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 */
const MAX_OVERROUND_EXCESS = 0.03;  // 3% = upper end of Pinnacle's observed range
// MAX_CONFIDENCE is defined above (shared with exchangeSpreadToConfidence).

export function overroundToConfidence(overround: number): number {
  const excess = overround - 1;                               // how much above 1.0
  const raw    = 1 - excess / MAX_OVERROUND_EXCESS;          // 0→high, 1→low confidence
  return Math.min(MAX_CONFIDENCE, Math.max(0, raw));
}

/**
 * Expected net profit (USDC) for a value bet on a Polymarket YES outcome.
 *
 * ⚠️  This is expected value, NOT guaranteed profit. The event can resolve NO.
 *
 * We BUY `shares` YES tokens at `polymarketPrice` each.
 *   Expected payout   = fairProbability × shares × $1   (prob-weighted)
 *   Cost              = polymarketPrice × shares
 *   Taker fee         = shares × feeRate × polymarketPrice × (1 − polymarketPrice)
 *   Expected net      = (fairProbability − polymarketPrice) × shares − fee
 *
 * Returns a negative value when the edge is insufficient to cover the fee.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param fairProbability - De-vigged Pinnacle probability for this outcome (0–1)
 * @param polymarketPrice - Current Polymarket YES price / share (0–1)
 * @param shares          - Number of YES shares to buy
 * @param feeRate         - Taker fee coefficient (default: SPORTS_FEE_RATE = 0.05)
 * @returns Expected net profit in USDC (positive = value bet, negative = pass)
 *
 * @example
 * // Pinnacle implies 60% fair probability; Polymarket offers YES at 0.52
 * // shares = 10, feeRate = 0.05
 * // expectedGross = (0.60 − 0.52) × 10 = $0.80
 * // fee           = 10 × 0.05 × 0.52 × 0.48 ≈ $0.1248
 * // expectedNet   ≈ $0.675
 * netProfitValueBet(0.60, 0.52, 10, 0.05)  // → ~0.675
 */
export function netProfitValueBet(
  fairProbability: number,
  polymarketPrice: number,
  shares: number,
  feeRate: number = SPORTS_FEE_RATE,
): number {
  const expectedGross = shares * (fairProbability - polymarketPrice);
  const fee           = feeForLeg(shares, polymarketPrice, feeRate);
  return expectedGross - fee;
}
