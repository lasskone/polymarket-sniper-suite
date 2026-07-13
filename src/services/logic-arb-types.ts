/**
 * Logic / Correlated-Markets Arbitrage — Types and Pure Functions
 *
 * Detects fee-adjusted arbitrage in pairs of logically-related binary markets.
 * Two relationship types are supported:
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. 'a_implies_b'  (A → B)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Logical invariant: if A resolves YES, B MUST also resolve YES.
 * By the law of total probability this forces price(B) ≥ price(A) at fair value.
 *
 * Mispricing condition: price(A) > price(B)
 *
 * Trade construction (per share):
 *   Leg 1 — Buy YES-B at price pB   (cost pB per share)
 *   Leg 2 — Buy NO-A  at price 1−pA (cost 1−pA per share)
 *
 * Payout table (A=YES,B=NO is logically impossible by the constraint):
 *   ┌──────────────┬────────────────────┬────────────────────┬──────────────────────┐
 *   │ Outcome      │ YES-B pays         │ NO-A pays          │ Total payout         │
 *   ├──────────────┼────────────────────┼────────────────────┼──────────────────────┤
 *   │ A=YES, B=YES │ $1                 │ $0                 │ $1                   │
 *   │ A=NO,  B=YES │ $1                 │ $1                 │ $2  (best case)      │
 *   │ A=NO,  B=NO  │ $0                 │ $1                 │ $1                   │
 *   └──────────────┴────────────────────┴────────────────────┴──────────────────────┘
 *
 * Guaranteed minimum payout: $1 per share (all realizable outcomes pay ≥ $1).
 * Total cost per share:      pB + (1 − pA)
 * Guaranteed gross profit:   $1 − [pB + (1−pA)] = pA − pB  (> 0 when mispriced)
 *
 * Taker fees (formula: shares × feeRate × p × (1−p)):
 *   Fee Leg 1 (YES-B at pB):   shares × feeRate × pB × (1−pB)
 *   Fee Leg 2 (NO-A at 1−pA):  shares × feeRate × (1−pA) × pA
 *
 * Net profit = shares × (pA − pB) − fee_leg1 − fee_leg2
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2. 'mutually_exclusive'  (A ∩ B = ∅)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Logical invariant: A and B cannot both resolve YES.
 * This forces price(A) + price(B) ≤ 1 at fair value.
 *
 * Mispricing condition: price(A) + price(B) > 1
 *
 * This is identical to the NegRisk short-arb with n=2 outcomes.
 * Trade construction (per share):
 *   Leg 1 — Buy NO-A at price 1−pA
 *   Leg 2 — Buy NO-B at price 1−pB
 *
 * Payout table:
 *   ┌──────────────┬────────────────────┬────────────────────┬──────────────────────┐
 *   │ Outcome      │ NO-A pays          │ NO-B pays          │ Total payout         │
 *   ├──────────────┼────────────────────┼────────────────────┼──────────────────────┤
 *   │ A=YES        │ $0                 │ $1                 │ $1                   │
 *   │ B=YES        │ $1                 │ $0                 │ $1                   │
 *   │ Neither      │ $1                 │ $1                 │ $2  (best case)      │
 *   │ Both=YES     │ IMPOSSIBLE (A∩B=∅) │                    │                      │
 *   └──────────────┴────────────────────┴────────────────────┴──────────────────────┘
 *
 * Guaranteed minimum payout: $1 per share.
 * Total cost per share:      (1−pA) + (1−pB) = 2 − pA − pB
 * Guaranteed gross profit:   $1 − (2−pA−pB) = pA + pB − 1  (> 0 when mispriced)
 *
 * Taker fees:
 *   Fee Leg 1 (NO-A at 1−pA): shares × feeRate × (1−pA) × pA
 *   Fee Leg 2 (NO-B at 1−pB): shares × feeRate × (1−pB) × pB
 *
 * Net profit = shares × (pA+pB−1) − fee_leg1 − fee_leg2
 *   (Same as netProfitShortArb([pA, pB], shares, feeRate) from negrisk-arb-types.)
 */

import {
  feeForLeg,
  netProfitShortArb,
  feeRateFromBps,
  NEGRISK_FEE_RATE,
  FEE_RATE_BPS_DIVISOR,
} from './negrisk-arb-types.js';

// Re-export the shared fee utilities so callers don't need to depend on negrisk-arb-types.
export { feeRateFromBps, FEE_RATE_BPS_DIVISOR };

// ============= Constants =============

/**
 * Default taker fee rate fallback for logic-arb markets.
 *
 * Reuses the politics-category value (0.04 = 400 bps) as the conservative
 * default — the live per-market rate from the CLOB API is always preferred.
 */
export const LOGIC_ARB_FEE_RATE: number = NEGRISK_FEE_RATE;  // 0.04

// ============= Types =============

/** The two supported logical relationships between a pair of binary markets. */
export type LogicArbRelationship = 'a_implies_b' | 'mutually_exclusive';

/** Configuration for LogicArbService. */
export interface LogicArbConfig {
  /** Shares to buy per leg in profit calculations. @default 10 */
  shares: number;
  /** Minimum fee-adjusted net profit (USDC) to emit a signal. @default 0.05 */
  minNetProfitUSD: number;
  /** Polling interval between scans (ms). @default 60_000 */
  scanIntervalMs: number;
  /** Fallback taker fee rate coefficient. @default LOGIC_ARB_FEE_RATE */
  feeRate: number;
}

/** Which tokens to buy on each leg to lock in the guaranteed profit. */
export interface LogicArbTradeLegs {
  /** 'YES' or 'NO' token on market A, and the fill price. */
  legA: { token: 'YES' | 'NO'; price: number };
  /** 'YES' or 'NO' token on market B, and the fill price. */
  legB: { token: 'YES' | 'NO'; price: number };
}

/** Emitted by LogicArbService when a profitable opportunity is detected. */
export interface LogicArbSignal {
  /** Supabase UUID of the correlated_market_pairs row. */
  pairId: string;
  /** Condition ID of market A. */
  marketAConditionId: string;
  /** Condition ID of market B. */
  marketBConditionId: string;
  /** Human-readable slug for market A. */
  marketASlug: string;
  /** Human-readable slug for market B. */
  marketBSlug: string;
  /** Logical relationship type. */
  relationship: LogicArbRelationship;
  /** Current YES price of market A. */
  priceA: number;
  /** Current YES price of market B. */
  priceB: number;
  /** Magnitude of the mispricing (always positive when a signal fires). */
  deviation: number;
  /** Fee-adjusted net profit in USDC for `shares` shares per leg. */
  netProfitUSD: number;
  /** Number of shares per leg used in the calculation. */
  shares: number;
  /** Taker fee rate used (live from CLOB API or fallback). */
  feeRate: number;
  /** Which tokens to buy on each leg. */
  trade: LogicArbTradeLegs;
}

/** Emitted after each scan cycle completes. */
export interface LogicArbScanResult {
  /** Total active pairs loaded from Supabase. */
  pairsTotal: number;
  /** Pairs for which both market prices were successfully fetched. */
  pairsScanned: number;
  /** Timestamp of the scan. */
  scannedAt: number;
}

// ============= Pure Functions =============

/**
 * Returns true when a logic-arb opportunity exists for the given relationship
 * and current prices.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param relationship - Logical relationship between markets A and B
 * @param priceA       - Current YES price of market A (0–1)
 * @param priceB       - Current YES price of market B (0–1)
 */
export function isLogicArbOpportunity(
  relationship: LogicArbRelationship,
  priceA: number,
  priceB: number,
): boolean {
  if (relationship === 'a_implies_b')      return priceA > priceB;
  /* mutually_exclusive */                 return priceA + priceB > 1;
}

/**
 * Returns the magnitude of the mispricing relative to the fair-value invariant.
 * Always positive when isLogicArbOpportunity() is true.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param relationship - Logical relationship between markets A and B
 * @param priceA       - Current YES price of market A (0–1)
 * @param priceB       - Current YES price of market B (0–1)
 * @returns Deviation from fair value (positive = mispriced; negative = not mispriced)
 *
 * @example
 * logicArbDeviation('a_implies_b', 0.70, 0.60)          // → 0.10
 * logicArbDeviation('mutually_exclusive', 0.65, 0.55)   // → 0.20
 */
export function logicArbDeviation(
  relationship: LogicArbRelationship,
  priceA: number,
  priceB: number,
): number {
  if (relationship === 'a_implies_b')  return priceA - priceB;
  /* mutually_exclusive */             return priceA + priceB - 1;
}

/**
 * Returns the trade legs required to lock in the arbitrage profit.
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param relationship - Logical relationship between markets A and B
 * @param priceA       - Current YES price of market A
 * @param priceB       - Current YES price of market B
 */
export function logicArbTradeLegs(
  relationship: LogicArbRelationship,
  priceA: number,
  priceB: number,
): LogicArbTradeLegs {
  if (relationship === 'a_implies_b') {
    // Buy YES-B (cheaper than A) + Buy NO-A (bet against the overpriced side)
    return {
      legA: { token: 'NO',  price: 1 - priceA },
      legB: { token: 'YES', price: priceB },
    };
  }
  // mutually_exclusive: short both (buy both NO tokens)
  return {
    legA: { token: 'NO', price: 1 - priceA },
    legB: { token: 'NO', price: 1 - priceB },
  };
}

/**
 * Net profit (in USDC) for a logic-arb trade after taker fees.
 *
 * Dispatches to the appropriate formula based on the relationship type.
 * Returns a negative value when fees eat the gross profit (no-trade signal).
 *
 * This is a **pure function** — unit-testable with no dependencies.
 *
 * @param relationship - Logical relationship between markets A and B
 * @param priceA       - Current YES price of market A (0–1)
 * @param priceB       - Current YES price of market B (0–1)
 * @param shares       - Number of shares to trade per leg
 * @param feeRate      - Taker fee coefficient (default: LOGIC_ARB_FEE_RATE = 0.04)
 * @returns Net profit in USDC (positive = profitable after fees)
 *
 * @example
 * // a_implies_b: pA=0.70, pB=0.60, 10 shares, feeRate=0.04
 * // gross = 10 × (0.70 − 0.60) = $1.00
 * // feeYesB = 10 × 0.04 × 0.60 × 0.40 = $0.096
 * // feeNoA  = 10 × 0.04 × 0.30 × 0.70 = $0.084
 * // net ≈ $1.00 − $0.096 − $0.084 = $0.820
 * netProfitLogicArb('a_implies_b', 0.70, 0.60, 10, 0.04)  // → 0.820
 *
 * @example
 * // mutually_exclusive: pA=0.65, pB=0.55, 10 shares, feeRate=0.04
 * // gross = 10 × (0.65 + 0.55 − 1) = $2.00
 * // feeNoA = 10 × 0.04 × 0.35 × 0.65 = $0.091
 * // feeNoB = 10 × 0.04 × 0.45 × 0.55 = $0.099
 * // net ≈ $2.00 − $0.091 − $0.099 = $1.81
 * netProfitLogicArb('mutually_exclusive', 0.65, 0.55, 10, 0.04)  // → 1.81
 */
export function netProfitLogicArb(
  relationship: LogicArbRelationship,
  priceA: number,
  priceB: number,
  shares: number,
  feeRate: number = LOGIC_ARB_FEE_RATE,
): number {
  if (relationship === 'a_implies_b') {
    // Guaranteed gross profit: shares × (pA − pB)
    // Legs: Buy YES-B at pB, Buy NO-A at (1−pA)
    const grossProfit = shares * (priceA - priceB);
    const feeYesB    = feeForLeg(shares, priceB,      feeRate);
    const feeNoA     = feeForLeg(shares, 1 - priceA,  feeRate);
    return grossProfit - feeYesB - feeNoA;
  }

  // mutually_exclusive: identical to NegRisk short-arb with 2 outcomes.
  // Legs: Buy NO-A at (1−pA), Buy NO-B at (1−pB).
  // Guaranteed gross profit: shares × (pA + pB − 1)
  return netProfitShortArb([priceA, priceB], shares, feeRate);
}
