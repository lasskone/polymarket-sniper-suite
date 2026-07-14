/**
 * Unit tests for sportsbook-arb pure functions.
 *
 * All functions are pure (no I/O) so tests are deterministic.
 * Tests cover:
 *   - midPriceFairProbability: exchange mid-price formula (primary de-vig method)
 *   - exchangeSpreadToConfidence: spread → confidence mapping
 *   - devigOddsToProbability: legacy formula retained for reference (not used
 *     in production with Betfair Exchange — exchanges have near-zero overround)
 *   - pinnacleOverround / overroundToConfidence: legacy, retained for tests
 *   - netProfitValueBet: profitable edge, fee-eats-margin, at-parity, fee sensitivity
 */

import { describe, it, expect } from 'vitest';
import {
  midPriceFairProbability,
  exchangeSpreadToConfidence,
  devigOddsToProbability,
  pinnacleOverround,
  overroundToConfidence,
  netProfitValueBet,
  SPORTS_FEE_RATE,
} from '../services/sportsbook-arb-types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fee for buying YES at price p: shares × feeRate × p × (1−p) */
function legFee(shares: number, price: number, feeRate: number): number {
  return shares * feeRate * price * (1 - price);
}

// ─── midPriceFairProbability ──────────────────────────────────────────────────

describe('midPriceFairProbability', () => {
  it('formula: 2 / (back + lay)', () => {
    // France vs Spain observed prices: back=3.45, lay=3.75
    // mid = (3.45 + 3.75) / 2 = 3.60  →  fairProb = 1/3.60 ≈ 0.2778
    expect(midPriceFairProbability(3.45, 3.75)).toBeCloseTo(2 / (3.45 + 3.75), 10);
  });

  it('symmetric: same spread, wider prices → lower probability', () => {
    const p1 = midPriceFairProbability(1.17, 1.20);   // heavy favourite
    const p2 = midPriceFairProbability(3.45, 3.75);   // moderate underdog
    expect(p1).toBeGreaterThan(p2);
    expect(p1).toBeCloseTo(2 / (1.17 + 1.20), 10);
  });

  it('heavy favourite: back=1.10, lay=1.12 → fairProb > 0.89', () => {
    const p = midPriceFairProbability(1.10, 1.12);
    expect(p).toBeGreaterThan(0.89);
    expect(p).toBeLessThan(1.0);
  });

  it('evens-market equivalent: back=1.98, lay=2.02 → fairProb ≈ 0.50', () => {
    expect(midPriceFairProbability(1.98, 2.02)).toBeCloseTo(0.50, 2);
  });

  it('throws if backPrice ≤ 1', () => {
    expect(() => midPriceFairProbability(1.0, 1.5)).toThrow();
    expect(() => midPriceFairProbability(0.9, 1.5)).toThrow();
  });

  it('throws if layPrice ≤ backPrice', () => {
    expect(() => midPriceFairProbability(2.0, 2.0)).toThrow();
    expect(() => midPriceFairProbability(2.0, 1.9)).toThrow();
  });

  it('result is always in (0, 1) for valid inputs', () => {
    const pairs: [number, number][] = [
      [1.01, 1.02], [1.5, 1.6], [2.0, 2.2], [5.0, 5.5], [20.0, 22.0],
    ];
    for (const [b, l] of pairs) {
      const p = midPriceFairProbability(b, l);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});

// ─── exchangeSpreadToConfidence ───────────────────────────────────────────────

describe('exchangeSpreadToConfidence', () => {
  it('tight spread (≈2.5%): high confidence close to MAX (0.90)', () => {
    // back=1.17, lay=1.20 → mid=1.185 → spread=(0.03/1.185)≈2.53%
    // confidence = min(0.90, 1 - 0.0253/0.10) = min(0.90, 0.747) = 0.747
    const conf = exchangeSpreadToConfidence(1.17, 1.20);
    const mid    = (1.17 + 1.20) / 2;
    const spread = (1.20 - 1.17) / mid;
    expect(conf).toBeCloseTo(Math.min(0.90, 1 - spread / 0.10), 10);
    expect(conf).toBeLessThanOrEqual(0.90);
    expect(conf).toBeGreaterThan(0.60);
  });

  it('zero spread is not possible (lay > back required), very tight → MAX_CONFIDENCE', () => {
    // Spread as close to 0 as valid: back=1.99, lay=2.01 → ~1% spread
    const conf = exchangeSpreadToConfidence(1.99, 2.01);
    expect(conf).toBeLessThanOrEqual(0.90);
    expect(conf).toBeGreaterThan(0.80);
  });

  it('exactly 10% fractional spread → confidence = 0', () => {
    // back=2.0, lay = 2.0 * (1 + 0.10 * 2.0/1.0) ... let me compute:
    // spread = (lay-back)/mid = 0.10 → lay-back = 0.10 * mid = 0.10 * (back+lay)/2
    // Solving: lay - back = 0.05*(back+lay) → 0.95*lay = 1.05*back → lay = back*21/19
    // For back=1.90: lay = 1.90 * 21/19 = 2.10 → mid=2.00 → spread=0.20/2.00=0.10 ✓
    expect(exchangeSpreadToConfidence(1.90, 2.10)).toBeCloseTo(0, 2);
  });

  it('spread > 10%: confidence clamped to 0, not negative', () => {
    expect(exchangeSpreadToConfidence(1.5, 2.5)).toBe(0);
    expect(exchangeSpreadToConfidence(2.0, 4.0)).toBe(0);
  });

  it('confidence is monotonically decreasing as spread widens', () => {
    const pairs: [number, number][] = [
      [2.0, 2.02],   // ~1% spread
      [2.0, 2.1],    // ~5% spread
      [2.0, 2.2],    // ~9.5% spread
      [2.0, 2.5],    // >10% → 0
    ];
    const confs = pairs.map(([b, l]) => exchangeSpreadToConfidence(b, l));
    for (let i = 1; i < confs.length; i++) {
      expect(confs[i]).toBeLessThanOrEqual(confs[i - 1]!);
    }
  });

  it('always ≤ MAX_CONFIDENCE (0.90)', () => {
    expect(exchangeSpreadToConfidence(1.01, 1.02)).toBeLessThanOrEqual(0.90);
    expect(exchangeSpreadToConfidence(1.001, 1.002)).toBeLessThanOrEqual(0.90);
  });
});

// ─── midPriceFairProbability + netProfitValueBet: round-trip ─────────────────

describe('exchange fair probability → netProfitValueBet round-trip', () => {
  it('Betfair France back=3.45 lay=3.75, Polymarket France-wins at 0.25 → positive EV', () => {
    // Betfair mid-price: 2/(3.45+3.75) = 0.2778 (27.8%)
    // Polymarket: 0.25 (25.0%)
    // edge = 0.0278 → > minEdge (0.05 would not fire, but let's check the math)
    const fair = midPriceFairProbability(3.45, 3.75);
    expect(fair).toBeCloseTo(0.2778, 3);
    const net = netProfitValueBet(fair, 0.25, 10, SPORTS_FEE_RATE);
    expect(net).toBeGreaterThan(0);
  });

  it('Betfair back=1.83 lay=1.87, Polymarket at 0.50 → large positive EV', () => {
    const fair = midPriceFairProbability(1.83, 1.87);  // ~0.537
    expect(fair).toBeGreaterThan(0.50);
    const net = netProfitValueBet(fair, 0.50, 10, SPORTS_FEE_RATE);
    expect(net).toBeGreaterThan(0.20);
  });
});

// ─── devigOddsToProbability ───────────────────────────────────────────────────

describe('devigOddsToProbability', () => {
  it('balanced 2-outcome: [2.0, 2.0] → [0.5, 0.5]', () => {
    const probs = devigOddsToProbability([2.0, 2.0]);
    expect(probs).toHaveLength(2);
    expect(probs[0]).toBeCloseTo(0.5, 10);
    expect(probs[1]).toBeCloseTo(0.5, 10);
  });

  it('favourite/underdog: [1.50, 2.60] → fair probs sum to 1.0', () => {
    // raw: 1/1.50=0.6667, 1/2.60=0.3846 → overround=1.0513
    // fair: [0.6340, 0.3660]
    const probs = devigOddsToProbability([1.50, 2.60]);
    expect(probs[0]! + probs[1]!).toBeCloseTo(1.0, 10);
    expect(probs[0]).toBeGreaterThan(probs[1]!);  // favourite more likely
  });

  it('favourite/underdog: fair probabilities are proportional to raw implied', () => {
    const probs = devigOddsToProbability([1.83, 2.05]);
    const raw1  = 1 / 1.83;
    const raw2  = 1 / 2.05;
    const total = raw1 + raw2;
    expect(probs[0]).toBeCloseTo(raw1 / total, 10);
    expect(probs[1]).toBeCloseTo(raw2 / total, 10);
  });

  it('3-outcome soccer 1X2: probabilities sum to 1.0', () => {
    const probs = devigOddsToProbability([2.10, 3.40, 3.20]);
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 10);
    expect(probs).toHaveLength(3);
  });

  it('3-outcome: all fair probs are positive', () => {
    const probs = devigOddsToProbability([2.10, 3.40, 3.20]);
    for (const p of probs) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('throws on empty array', () => {
    expect(() => devigOddsToProbability([])).toThrow();
  });

  it('throws on odds ≤ 1', () => {
    expect(() => devigOddsToProbability([1.0, 2.0])).toThrow();
    expect(() => devigOddsToProbability([0.5, 2.0])).toThrow();
  });

  it('symmetric: swapping odds swaps fair probs', () => {
    const [p1, p2] = devigOddsToProbability([1.83, 2.05]);
    const [q1, q2] = devigOddsToProbability([2.05, 1.83]);
    expect(p1).toBeCloseTo(q2!, 10);
    expect(p2).toBeCloseTo(q1!, 10);
  });
});

// ─── pinnacleOverround ────────────────────────────────────────────────────────

describe('pinnacleOverround', () => {
  it('balanced 50/50: overround = 1.0 for decimal odds of 2.0/2.0', () => {
    expect(pinnacleOverround([2.0, 2.0])).toBeCloseTo(1.0, 10);
  });

  it('typical Pinnacle NBA line has overround in 1.010–1.030 range', () => {
    const or = pinnacleOverround([1.83, 2.05]);  // ~1.034
    expect(or).toBeGreaterThan(1.0);
    expect(or).toBeLessThan(1.1);
  });

  it('3-outcome soccer: overround > 1', () => {
    const or = pinnacleOverround([2.10, 3.40, 3.20]);
    expect(or).toBeGreaterThan(1.0);
  });
});

// ─── overroundToConfidence ────────────────────────────────────────────────────

describe('overroundToConfidence', () => {
  it('overround = 1.0 (no vig): confidence = MAX (0.90)', () => {
    expect(overroundToConfidence(1.0)).toBeCloseTo(0.90, 10);
  });

  it('overround = 1.03 (max expected): confidence = 0', () => {
    expect(overroundToConfidence(1.03)).toBeCloseTo(0, 2);
  });

  it('overround > 1.03: confidence clamped to 0, not negative', () => {
    expect(overroundToConfidence(1.10)).toBe(0);
  });

  it('confidence is monotonically decreasing with overround', () => {
    const ors = [1.00, 1.01, 1.015, 1.02, 1.025, 1.03];
    const confs = ors.map(overroundToConfidence);
    for (let i = 1; i < confs.length; i++) {
      expect(confs[i]).toBeLessThanOrEqual(confs[i - 1]!);
    }
  });

  it('confidence is always ≤ 0.90 (directional bet — never full confidence)', () => {
    for (const or of [1.0, 1.01, 1.005, 0.999]) {
      expect(overroundToConfidence(or)).toBeLessThanOrEqual(0.90);
    }
  });
});

// ─── netProfitValueBet ────────────────────────────────────────────────────────

describe('netProfitValueBet', () => {
  const SHARES = 10;
  const FEE = SPORTS_FEE_RATE;  // 0.05

  it('profitable edge: fairProb=0.60, polyPrice=0.52 → positive expected profit', () => {
    // gross = 10 × (0.60 − 0.52) = $0.80
    // fee   = 10 × 0.05 × 0.52 × 0.48 = $0.1248
    // net   ≈ $0.6752
    const net = netProfitValueBet(0.60, 0.52, SHARES, FEE);
    expect(net).toBeGreaterThan(0);
  });

  it('matches formula exactly: gross − legFee(shares, polyPrice)', () => {
    const fairProb = 0.60, polyPrice = 0.52;
    const expectedGross = SHARES * (fairProb - polyPrice);
    const expectedFee   = legFee(SHARES, polyPrice, FEE);
    expect(netProfitValueBet(fairProb, polyPrice, SHARES, FEE))
      .toBeCloseTo(expectedGross - expectedFee, 10);
  });

  it('thin edge: fairProb=0.52, polyPrice=0.50 → fee eats most or all of margin', () => {
    // gross = 10 × 0.02 = $0.20; fee ≈ 10 × 0.05 × 0.50 × 0.50 = $0.125
    // net ≈ $0.075 — small positive but below typical minNetProfitUSD threshold
    const net = netProfitValueBet(0.52, 0.50, SHARES, FEE);
    expect(net).toBeGreaterThan(0);
    expect(net).toBeLessThan(0.10);
  });

  it('at-parity: fairProb = polyPrice → negative (pure fee drag)', () => {
    const net = netProfitValueBet(0.55, 0.55, SHARES, FEE);
    expect(net).toBeLessThan(0);
  });

  it('inverted (fairProb < polyPrice): strictly negative', () => {
    const net = netProfitValueBet(0.45, 0.55, SHARES, FEE);
    expect(net).toBeLessThan(0);
  });

  it('large edge (fairProb=0.70, polyPrice=0.45): highly profitable', () => {
    const net = netProfitValueBet(0.70, 0.45, SHARES, FEE);
    expect(net).toBeGreaterThan(2.0);
  });

  it('higher feeRate reduces expected net profit', () => {
    const net005 = netProfitValueBet(0.60, 0.50, SHARES, 0.05);
    const net010 = netProfitValueBet(0.60, 0.50, SHARES, 0.10);
    expect(net005).toBeGreaterThan(net010);
  });

  it('more shares scales profit linearly (gross) but fee is also larger', () => {
    // Expected profit should scale with shares (both gross and fee scale linearly)
    const net10 = netProfitValueBet(0.65, 0.55, 10, FEE);
    const net20 = netProfitValueBet(0.65, 0.55, 20, FEE);
    expect(net20).toBeCloseTo(net10 * 2, 10);
  });

  it('default feeRate is SPORTS_FEE_RATE (0.05)', () => {
    expect(netProfitValueBet(0.60, 0.52, SHARES))
      .toBeCloseTo(netProfitValueBet(0.60, 0.52, SHARES, SPORTS_FEE_RATE), 10);
  });
});

// ─── Cross-function consistency ───────────────────────────────────────────────

describe('cross-function consistency', () => {
  it('devigOddsToProbability output used in netProfitValueBet: full round-trip', () => {
    // Typical NBA line: Pinnacle offering favourite at 1.83, underdog at 2.05
    // Polymarket misprices underdog at 0.44 (Pinnacle fair = ~0.472)
    const [, underdogFairProb] = devigOddsToProbability([1.83, 2.05]);
    const polymarketUnderdogPrice = 0.44;
    const net = netProfitValueBet(underdogFairProb!, polymarketUnderdogPrice, 10, 0.05);
    // edge ≈ 0.472 - 0.44 = 0.032 → small but positive after fee
    expect(net).toBeGreaterThan(0);
  });
});
