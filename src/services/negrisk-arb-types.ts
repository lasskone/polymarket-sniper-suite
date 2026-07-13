/**
 * NegRisk Arbitrage Service Types
 *
 * 多结果市场套利类型定义 (Winner-Take-All Events)
 *
 * 策略原理：
 * 在 Polymarket 的 NegRisk 多结果事件中（选举、锦标赛等）：
 *
 * 1. 每个事件有 n 个结果市场，每个市场是二元 YES/NO
 * 2. 恰好一个结果会赢（Winner-Take-All）
 * 3. 不变量：Σ(YES prices) 应该等于 $1.00
 *
 * 4. 套利机会：
 *    - Long  Arb: Σ(YES) < 1 → 买入所有 YES → 保证 $1 收益/份
 *    - Short Arb: Σ(YES) > 1 → 买入所有 NO  → 保证 (n-1) 收益/份
 *
 * Reference: docs/arb/arbitrage.md §9
 */

// ============= Fee Constants =============

/**
 * Fallback taker fee rate coefficient for **politics-category** NegRisk markets.
 *
 * This constant is used ONLY when the live per-market fee cannot be fetched from
 * the CLOB API (network error, unknown conditionId, etc.). When the live fetch
 * succeeds, the actual `taker_base_fee` from the market is used instead.
 *
 * Formula (same structure as crypto markets):
 *   fee = shares × feeRate × p × (1 − p)
 *
 * Where feeRate is derived from the CLOB API response:
 *   feeRate = taker_base_fee / 10_000        (taker_base_fee is in basis points)
 *
 * This default (0.04 = 400 bps) corresponds to the **politics** category on Polymarket.
 * Other NegRisk categories use different rates, e.g. sports can be as high as 0.10.
 *
 * Source: https://docs.polymarket.com/trading/fees.md
 * Live verification: GET https://clob.polymarket.com/markets/{conditionId}
 *                     → response.taker_base_fee (integer, basis points)
 *
 * Examples at this rate (10 shares):
 *   p = 0.10 → $0.036   p = 0.30 → $0.084   p = 0.50 → $0.100
 */
export const NEGRISK_FEE_RATE = 0.04;

/** Basis-point divisor for converting CLOB API taker_base_fee → feeRate coefficient. */
export const FEE_RATE_BPS_DIVISOR = 10_000;

/**
 * Convert a raw `taker_base_fee` value (integer, basis points) returned by
 * `GET https://clob.polymarket.com/markets/{conditionId}` to the fee-rate
 * coefficient used in the fee formula.
 *
 * Returns the fallback constant when the fetched value is null, zero, or negative
 * (indicating the API call failed or the market has no fee data).
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param takerBaseFeeBps - Raw `taker_base_fee` from CLOB API, or null on fetch failure
 * @param fallback        - Coefficient to use when data is unavailable (default: NEGRISK_FEE_RATE)
 * @returns Fee-rate coefficient (e.g. 0.04, 0.07, 0.10)
 *
 * @example
 * feeRateFromBps(1000)   // 1000 bps → 0.10  (sports category observed in production)
 * feeRateFromBps(400)    // 400  bps → 0.04  (politics category)
 * feeRateFromBps(700)    // 700  bps → 0.07  (crypto — matches CRYPTO_FEE_RATE)
 * feeRateFromBps(null)   // fetch failed → NEGRISK_FEE_RATE fallback (0.04)
 * feeRateFromBps(0)      // zero fee (settled/exempt market) → fallback to avoid bad math
 */
export function feeRateFromBps(
  takerBaseFeeBps: number | null,
  fallback: number = NEGRISK_FEE_RATE,
): number {
  if (takerBaseFeeBps === null || takerBaseFeeBps <= 0) return fallback;
  return takerBaseFeeBps / FEE_RATE_BPS_DIVISOR;
}

// ============= Pure Fee Functions =============

/**
 * Taker fee for a single leg of a NegRisk arb trade.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param shares  - Number of shares traded
 * @param price   - Fill price of this leg (0–1)
 * @param feeRate - Taker fee coefficient (default: NEGRISK_FEE_RATE = 0.02)
 */
export function feeForLeg(
  shares: number,
  price: number,
  feeRate: number = NEGRISK_FEE_RATE,
): number {
  return shares * feeRate * price * (1 - price);
}

/**
 * Net profit (in USDC) for a **Long NegRisk Arb** after taker fees.
 *
 * Strategy: buy YES on every outcome when Σ(YES prices) < 1.
 *
 * Guaranteed payout: exactly $1 per share (one outcome MUST resolve YES,
 * so exactly one YES token redeems for $1; the rest expire worthless — but
 * you hold ALL of them, so the winner covers the cost of the losers).
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param yesPrices - YES prices for each outcome (e.g. [0.30, 0.28, 0.22, 0.12])
 * @param shares    - Shares to buy per leg
 * @param feeRate   - Taker fee coefficient (default: NEGRISK_FEE_RATE)
 * @returns Net profit in USDC (positive = profitable)
 *
 * @example
 * // 4-outcome event: YES prices sum to 0.92, 10 shares
 * // gross  = (1 − 0.92) × 10 = $0.80
 * // total fees ≈ $0.14 (sum of per-leg fees at each YES price)
 * // net    ≈ $0.66
 * netProfitLongArb([0.30, 0.28, 0.22, 0.12], 10)
 */
export function netProfitLongArb(
  yesPrices: readonly number[],
  shares: number,
  feeRate: number = NEGRISK_FEE_RATE,
): number {
  const totalCost  = yesPrices.reduce((acc, p) => acc + p * shares, 0);
  const totalFees  = yesPrices.reduce((acc, p) => acc + feeForLeg(shares, p, feeRate), 0);
  const payout     = shares * 1; // guaranteed: exactly one YES resolves
  return payout - totalCost - totalFees;
}

/**
 * Net profit (in USDC) for a **Short NegRisk Arb** after taker fees.
 *
 * Strategy: buy NO on every outcome when Σ(YES prices) > 1.
 *
 * Guaranteed payout: (n−1) per share, where n = number of outcomes.
 * Exactly one NO token will expire worthless (the winning outcome's NO),
 * but n−1 NO tokens each redeem for $1 = (n−1) total.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param yesPrices - YES prices for each outcome (NO price = 1 − yesPrice)
 * @param shares    - Shares to buy per NO leg
 * @param feeRate   - Taker fee coefficient (default: NEGRISK_FEE_RATE)
 * @returns Net profit in USDC (positive = profitable)
 *
 * @example
 * // 5-outcome event: YES prices sum to 1.08, 10 shares
 * // NO prices: [0.55, 0.65, 0.85, 0.92, 0.95]
 * // cost    = 3.92 × 10 = $39.20
 * // payout  = (5−1) × 10 = $40.00
 * // gross   = $0.80, minus total fees
 * netProfitShortArb([0.45, 0.35, 0.15, 0.08, 0.05], 10)
 */
export function netProfitShortArb(
  yesPrices: readonly number[],
  shares: number,
  feeRate: number = NEGRISK_FEE_RATE,
): number {
  const noPrices   = yesPrices.map(p => 1 - p);
  const totalCost  = noPrices.reduce((acc, p) => acc + p * shares, 0);
  const totalFees  = noPrices.reduce((acc, p) => acc + feeForLeg(shares, p, feeRate), 0);
  const payout     = shares * (yesPrices.length - 1); // (n−1) NO tokens each pay $1
  return payout - totalCost - totalFees;
}

// ============= Types =============

/** Direction of the arbitrage trade. */
export type NegRiskArbDirection = 'long' | 'short';

/** Emitted by NegRiskArbService when a profitable opportunity is detected. */
export interface NegRiskArbSignal {
  /** Internal Gamma event ID. */
  eventId: string;
  /** Human-readable event title (e.g. "2024 US Presidential Election"). */
  eventTitle: string;
  /** 'long' = buy all YES; 'short' = buy all NO. */
  direction: NegRiskArbDirection;
  /** Σ(YES prices across all outcome markets). */
  yesSum: number;
  /** Absolute deviation from 1.00 (mispricing magnitude). */
  deviation: number;
  /** Fee-adjusted net profit in USDC for `shares` shares per leg. */
  netProfitUSD: number;
  /** Number of shares per leg used in the calculation. */
  shares: number;
  /** Number of outcome markets in this event. */
  outcomeCount: number;
  /** conditionId for each outcome market (same order as yesPrices). */
  marketIds: string[];
}

/** Emitted by NegRiskArbService after each scan completes. */
export interface NegRiskScanResult {
  /** Total active events returned by the Gamma API. */
  eventsTotal: number;
  /** Events with enough outcomes to qualify as NegRisk candidates. */
  negRiskEvents: number;
  /** Timestamp of the scan. */
  scannedAt: number;
}

/** Configuration for NegRiskArbService. */
export interface NegRiskArbConfig {
  /** Shares to buy per leg in profit calculations. @default 10 */
  shares: number;
  /** Minimum fee-adjusted net profit (USDC) required to emit a signal. @default 0.05 */
  minNetProfitUSD: number;
  /** Polling interval between scans (ms). @default 30_000 */
  scanIntervalMs: number;
  /** Minimum outcome count to consider an event as NegRisk. @default 3 */
  minOutcomes: number;
  /** Maximum outcome count (avoids pathologically wide events). @default 25 */
  maxOutcomes: number;
  /** Override taker fee rate. @default NEGRISK_FEE_RATE */
  feeRate: number;
}
