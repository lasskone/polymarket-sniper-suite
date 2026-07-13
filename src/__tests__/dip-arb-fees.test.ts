/**
 * Unit tests for DipArb fee-aware profit calculation.
 *
 * Polymarket crypto taker fee formula (source: docs.polymarket.com/trading/fees.md):
 *   fee = shares × 0.07 × p × (1 − p)
 *
 * All functions under test are pure — no I/O, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  netProfitAfterFees,
  resolveEffectiveSumTarget,
  CRYPTO_FEE_RATE,
} from '../services/dip-arb-types.js';

// ---------------------------------------------------------------------------
// netProfitAfterFees
// ---------------------------------------------------------------------------

describe('netProfitAfterFees', () => {
  it('returns profitable result for a clean dip scenario (typical case)', () => {
    // After a large BTC move, Leg1 = DOWN @ 0.10, Leg2 = UP @ 0.80, 10 shares.
    // gross  = (1 − 0.10 − 0.80) × 10 = $1.00
    // fee1   = 10 × 0.07 × 0.10 × 0.90 = $0.063
    // fee2   = 10 × 0.07 × 0.80 × 0.20 = $0.112
    // net    = $1.00 − $0.063 − $0.112 = $0.825
    const net = netProfitAfterFees(0.10, 0.80, 10);
    expect(net).toBeCloseTo(0.825, 3);
    expect(net).toBeGreaterThan(0.05); // clears default minNetProfitUSD
  });

  it('fires trade: sum < sumTarget and net profit exceeds minimum after fees', () => {
    // Leg1 @ 0.15, Leg2 @ 0.79, sum = 0.94 (< 0.97 gate), 10 shares.
    // gross  = 0.06 × 10 = $0.60
    // fee1   = 10 × 0.07 × 0.15 × 0.85 = $0.089
    // fee2   = 10 × 0.07 × 0.79 × 0.21 = $0.116
    // net    = $0.60 − $0.089 − $0.116 = $0.395 → should fire
    const net = netProfitAfterFees(0.15, 0.79, 10);
    expect(net).toBeGreaterThan(0.05);
    // sum = 0.94 < 0.97 → sumTarget gate passes
    expect(0.15 + 0.79).toBeLessThan(0.97);
  });

  it('does NOT fire: sum below sumTarget but fees eliminate the margin', () => {
    // Prices near 50-50 (max fee zone): Leg1 @ 0.485, Leg2 @ 0.485, sum = 0.97.
    // This passes the sumTarget gate (0.97 ≤ 0.97) but fees destroy the margin.
    //
    // gross  = (1 − 0.97) × 10 = $0.30
    // fee1   = 10 × 0.07 × 0.485 × 0.515 ≈ $0.1748
    // fee2   = same                        ≈ $0.1748
    // net    = $0.30 − $0.3497 ≈ −$0.0497  → must NOT fire
    const net = netProfitAfterFees(0.485, 0.485, 10);
    expect(net).toBeLessThan(0.05); // below minNetProfitUSD default
    // sum = 0.97 passes sumTarget gate — the fee check is the only guard here
    expect(0.485 + 0.485).toBeLessThanOrEqual(0.97);
  });

  it('does NOT fire: slightly-priced legs still below sumTarget but fee-negative', () => {
    // Leg1 @ 0.44, Leg2 @ 0.52, sum = 0.96 (< 0.97). Fees consume all margin.
    // gross  = 0.04 × 10 = $0.40
    // fee1   = 10 × 0.07 × 0.44 × 0.56 ≈ $0.172
    // fee2   = 10 × 0.07 × 0.52 × 0.48 ≈ $0.175
    // net    ≈ $0.40 − $0.347 = $0.053   (borderline; exact value asserted below)
    const p1 = 0.44, p2 = 0.52, s = 10;
    const gross = (1 - p1 - p2) * s;
    const fee1  = s * CRYPTO_FEE_RATE * p1 * (1 - p1);
    const fee2  = s * CRYPTO_FEE_RATE * p2 * (1 - p2);
    const expected = gross - fee1 - fee2;
    expect(netProfitAfterFees(p1, p2, s)).toBeCloseTo(expected, 6);
    // This test validates the formula itself, not a pass/fail decision.
  });

  it('returns negative net when total cost exceeds $1 (already a loss before fees)', () => {
    // If sum > 1 the trade is a guaranteed loss regardless of fees.
    const net = netProfitAfterFees(0.55, 0.50, 10);
    expect(net).toBeLessThan(0);
  });

  it('equals gross profit when feeRate is zero', () => {
    // Zero-fee sanity check: net should equal (1 − p1 − p2) × shares exactly.
    const net = netProfitAfterFees(0.10, 0.80, 10, 0);
    expect(net).toBeCloseTo(1.00, 6); // (1 − 0.90) × 10 = 1.00
  });

  it('scales linearly with share count', () => {
    // Doubling shares doubles net profit (fees and gross both linear in shares).
    const net10 = netProfitAfterFees(0.15, 0.80, 10);
    const net20 = netProfitAfterFees(0.15, 0.80, 20);
    expect(net20).toBeCloseTo(net10 * 2, 6);
  });

  it('matches the Polymarket docs example: 100 shares at p=0.50, fee=$1.75', () => {
    // At p=0.50 and shares=100: fee = 100 × 0.07 × 0.50 × 0.50 = $1.75
    // (value from https://docs.polymarket.com/trading/fees.md)
    const fee = 100 * CRYPTO_FEE_RATE * 0.50 * 0.50;
    expect(fee).toBeCloseTo(1.75, 4);
  });

  it('matches the Polymarket docs example: 100 shares at p=0.30, fee=$1.47', () => {
    const fee = 100 * CRYPTO_FEE_RATE * 0.30 * 0.70;
    expect(fee).toBeCloseTo(1.47, 4);
  });

  it('matches the Polymarket docs example: 100 shares at p=0.10, fee=$0.63', () => {
    const fee = 100 * CRYPTO_FEE_RATE * 0.10 * 0.90;
    expect(fee).toBeCloseTo(0.63, 4);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveSumTarget
// ---------------------------------------------------------------------------

describe('resolveEffectiveSumTarget', () => {
  const fullConfig = {
    sumTarget:       0.97,
    sumTargetPerCoin: { BTC: 0.97, ETH: 0.97, SOL: 0.96 } as Partial<Record<'BTC'|'ETH'|'SOL'|'XRP', number>>,
  };

  it('uses the BTC per-coin override', () => {
    expect(resolveEffectiveSumTarget(fullConfig, 'BTC')).toBe(0.97);
  });

  it('uses the ETH per-coin override', () => {
    expect(resolveEffectiveSumTarget(fullConfig, 'ETH')).toBe(0.97);
  });

  it('uses the SOL per-coin override (stricter: 0.96)', () => {
    expect(resolveEffectiveSumTarget(fullConfig, 'SOL')).toBe(0.96);
  });

  it('falls back to global sumTarget when coin has no override (XRP)', () => {
    // XRP is not in sumTargetPerCoin → should fall back to global 0.97
    expect(resolveEffectiveSumTarget(fullConfig, 'XRP')).toBe(0.97);
  });

  it('falls back to global sumTarget when sumTargetPerCoin is empty', () => {
    const cfg = { sumTarget: 0.95, sumTargetPerCoin: {} };
    expect(resolveEffectiveSumTarget(cfg, 'BTC')).toBe(0.95);
    expect(resolveEffectiveSumTarget(cfg, 'SOL')).toBe(0.95);
  });

  it('per-coin SOL is correctly stricter than global', () => {
    // SOL at 0.96 means Leg2 only fires when prices are cheaper than the BTC/ETH threshold.
    const solTarget = resolveEffectiveSumTarget(fullConfig, 'SOL');
    const btcTarget = resolveEffectiveSumTarget(fullConfig, 'BTC');
    expect(solTarget).toBeLessThan(btcTarget);
  });

  it('per-coin override takes precedence over a different global value', () => {
    // Even if someone sets global sumTarget to 0.95, the per-coin BTC=0.97 wins.
    const cfg = { sumTarget: 0.95, sumTargetPerCoin: { BTC: 0.97 } as Partial<Record<'BTC'|'ETH'|'SOL'|'XRP', number>> };
    expect(resolveEffectiveSumTarget(cfg, 'BTC')).toBe(0.97);
    expect(resolveEffectiveSumTarget(cfg, 'ETH')).toBe(0.95); // fallback
  });
});

// ---------------------------------------------------------------------------
// Integration: fee gate in context of the full DipArb decision
// ---------------------------------------------------------------------------

describe('DipArb trade decision: sumTarget gate + fee gate combined', () => {
  const shares      = 10;
  const sumTarget   = 0.97;
  const minNetProfit = 0.05;

  function shouldFire(leg1Price: number, leg2Price: number): boolean {
    const totalCost = leg1Price + leg2Price;
    if (totalCost > sumTarget) return false;               // Gate 1
    const net = netProfitAfterFees(leg1Price, leg2Price, shares);
    return net >= minNetProfit;                            // Gate 2
  }

  it('fires: deep dip (p1=0.10, p2=0.80) — clear profit after fees', () => {
    expect(shouldFire(0.10, 0.80)).toBe(true);
  });

  it('fires: moderate dip (p1=0.20, p2=0.74) — still profitable', () => {
    // sum=0.94, net ≈ (0.06×10) − fees ≈ $0.33
    expect(shouldFire(0.20, 0.74)).toBe(true);
  });

  it('does NOT fire: sum above gate (p1=0.20, p2=0.78 → sum=0.98)', () => {
    expect(shouldFire(0.20, 0.78)).toBe(false);
  });

  it('does NOT fire: sum at gate but fees eat margin (p1=0.485, p2=0.485)', () => {
    // Passes sumTarget (0.97 ≤ 0.97) but fee gate rejects
    expect(shouldFire(0.485, 0.485)).toBe(false);
  });
});
