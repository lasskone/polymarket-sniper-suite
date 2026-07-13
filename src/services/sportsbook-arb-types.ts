/**
 * Sportsbook-vs-Polymarket Value Betting — Types and Pure Functions
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * Strategy overview
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Polymarket prices for sports outcomes are often set by a thin pool of retail
 * liquidity rather than professional market makers. When the sharp consensus
 * (Pinnacle's line, one of the lowest-vig books) implies a materially different
 * probability than Polymarket's YES price, there is a value-betting edge.
 *
 * IMPORTANT: This is a DIRECTIONAL bet, not a risk-free arbitrage.
 * The underlying event can resolve against us. The "profit" computed here is
 * an EXPECTED value (probability-weighted), not a guaranteed payout. Signals
 * from this service have an inherently lower confidence level than the locked-in
 * arbitrages produced by NegRiskArbService or LogicArbService.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * De-vig method: Multiplicative (Proportional)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * For n outcomes with decimal odds d₁, d₂, … dₙ:
 *   raw implied probability: rᵢ = 1 / dᵢ
 *   sum of raw probs (overround): K = Σ rᵢ  (> 1 due to bookmaker margin)
 *   fair probability: pᵢ = rᵢ / K
 *
 * Why multiplicative?
 *   1. Standard for 2-outcome markets; used by Pinnacle itself in their published
 *      margin guide.
 *   2. Unbiased: it scales all outcomes proportionally, favouring neither
 *      the favourite nor the underdog.
 *   3. Extends naturally to 3-outcome markets (soccer 1X2) without additional
 *      assumptions — just include the Draw odds.
 *   4. Simple, deterministic, no iteration required.
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
 * Note: SportsbookArbService cannot resolve per-market CLOB fees because
 * OddsPapi's response does not include a Polymarket conditionId (only the
 * ERC-1155 tokenId in exchangeMeta). SPORTS_FEE_RATE is therefore used as a
 * fixed cost assumption for all signals.
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
  /** Outcome name as returned by OddsPapi (e.g. "Home", "Away", "Draw"). */
  outcomeName: string;
  /**
   * Pinnacle decimal odds for this outcome (e.g. 2.10).
   * Decimal odds → implied prob = 1 / price.
   */
  pinnacleDecimalOdds: number;
  /** De-vigged fair probability implied by Pinnacle's line (0–1). */
  fairProbability: number;
  /**
   * Polymarket YES price for this outcome (0–1), taken from
   * exchangeMeta.back[0].cents — the native share price.
   */
  polymarketPrice: number;
  /**
   * Edge: fairProbability − polymarketPrice.
   * Positive = Polymarket is cheaper than Pinnacle's fair value → value bet on YES.
   * Negative = Polymarket is overpriced.
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
  /** OddsPapi market ID containing these outcomes, e.g. "101". */
  marketId: string;
  /** Home team / participant 1 name. */
  participant1Name: string;
  /** Away team / participant 2 name. */
  participant2Name: string;
  /** Sport name (e.g. "Soccer", "Basketball"). */
  sportName: string;
  /** Tournament / league name. */
  tournamentName: string;
  /** Match kick-off / tip-off time (ISO 8601). */
  startTime: string;
  /**
   * The specific outcome(s) where Polymarket underprices vs Pinnacle.
   * Typically 1 entry; multiple if both sides show edge simultaneously
   * (can happen with stale Polymarket prices).
   */
  legs: SportsbookArbLeg[];
  /**
   * Bookmaker overround for the Pinnacle line used in de-vig.
   * E.g. 1.022 = 2.2% margin. Lower overround → more reliable fair probability.
   */
  pinnacleOverround: number;
  /**
   * Confidence factor (0–1). Computed as:
   *   1 − pinnacleOverround_excess / max_expected_overround
   * Lower overround → higher confidence in the de-vigged fair probability.
   * Always treat this as directional/speculative; confidence is never 1.0.
   */
  confidence: number;
  /** Number of shares used in expectedNetProfitUSD calculation. */
  shares: number;
  /** Taker fee rate applied. */
  feeRate: number;
}

/** Emitted after each scan cycle completes. */
export interface SportsbookArbScanResult {
  /** Total fixtures polled from OddsPapi. */
  fixturesTotal: number;
  /** Fixtures that had Polymarket odds (Polymarket coverage is sparse on sports). */
  fixturesWithPolymarket: number;
  /** Timestamp of the scan. */
  scannedAt: number;
}

// ============= Pure Functions =============

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
const MAX_CONFIDENCE       = 0.90;  // directional bets are never full confidence

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
