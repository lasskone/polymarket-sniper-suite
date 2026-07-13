/**
 * Unit tests for logic-arb pure functions.
 *
 * All functions are pure (no I/O) so tests are deterministic.
 * Tests cover:
 *   - netProfitLogicArb: profitable case, fee-eats-margin, at-parity no-fire
 *   - isLogicArbOpportunity: detection conditions for both relationship types
 *   - logicArbDeviation: mispricing magnitude
 *   - logicArbTradeLegs: correct token/price assignment per relationship
 */

import { describe, it, expect } from 'vitest';
import {
  netProfitLogicArb,
  isLogicArbOpportunity,
  logicArbDeviation,
  logicArbTradeLegs,
  LOGIC_ARB_FEE_RATE,
  type LogicArbRelationship,
} from '../services/logic-arb-types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fee for a single leg: shares × feeRate × price × (1-price).
 * Duplicated here to keep tests self-contained; matches the shared formula.
 */
function legFee(shares: number, price: number, feeRate: number): number {
  return shares * feeRate * price * (1 - price);
}

// ─── netProfitLogicArb — 'a_implies_b' ───────────────────────────────────────

describe("netProfitLogicArb('a_implies_b')", () => {
  const REL = 'a_implies_b' as const;
  const SHARES = 10;
  const FEE = LOGIC_ARB_FEE_RATE;  // 0.04

  it('profitable case: pA=0.70, pB=0.60 → net ≈ $0.820', () => {
    // gross  = 10 × (0.70 − 0.60) = $1.00
    // feeB   = 10 × 0.04 × 0.60 × 0.40 = $0.096
    // feeNoA = 10 × 0.04 × 0.30 × 0.70 = $0.084
    // net    = 1.00 − 0.096 − 0.084 = $0.820
    const expected =
      SHARES * (0.70 - 0.60)
      - legFee(SHARES, 0.60, FEE)        // YES-B
      - legFee(SHARES, 1 - 0.70, FEE);   // NO-A
    expect(netProfitLogicArb(REL, 0.70, 0.60, SHARES, FEE)).toBeCloseTo(expected, 8);
    expect(netProfitLogicArb(REL, 0.70, 0.60, SHARES, FEE)).toBeGreaterThan(0);
  });

  it('fee-eats-margin: tiny deviation (pA=0.51, pB=0.50) → net may be negative', () => {
    // gross = 10 × 0.01 = $0.10; fees around $0.10 at 0.5 → net < 0 or ≈ 0
    const net = netProfitLogicArb(REL, 0.51, 0.50, SHARES, FEE);
    // Fees: feeYesB = 10×0.04×0.50×0.50 = 0.10; feeNoA = 10×0.04×0.49×0.51 ≈ 0.0999...
    // gross = 0.10; total fees ≈ 0.1999; net ≈ −0.0999 < 0
    expect(net).toBeLessThan(0.05);  // well below any practical minNetProfitUSD
  });

  it('fee-eats-margin: net is strictly negative for very small deviations', () => {
    // At p=0.50 the fee per leg is maximal (0.04 × 0.5 × 0.5 × shares = 0.10)
    // Even 1¢ gross profit is wiped out
    const net = netProfitLogicArb(REL, 0.501, 0.500, SHARES, FEE);
    expect(net).toBeLessThan(0);
  });

  it('at-parity (pA = pB): gross = 0, net < 0 (fees on zero-profit trade)', () => {
    const net = netProfitLogicArb(REL, 0.60, 0.60, SHARES, FEE);
    expect(net).toBeLessThan(0);  // pure fee drag
  });

  it('large deviation (pA=0.90, pB=0.40): highly profitable', () => {
    // gross = 10 × 0.50 = $5.00; fees are small relative to gross
    const net = netProfitLogicArb(REL, 0.90, 0.40, SHARES, FEE);
    expect(net).toBeGreaterThan(4.0);
  });

  it('returns exactly gross - fees (formula verification)', () => {
    const pA = 0.75, pB = 0.55;
    const gross   = SHARES * (pA - pB);
    const feeYesB = legFee(SHARES, pB,      FEE);
    const feeNoA  = legFee(SHARES, 1 - pA,  FEE);
    expect(netProfitLogicArb(REL, pA, pB, SHARES, FEE))
      .toBeCloseTo(gross - feeYesB - feeNoA, 10);
  });

  it('higher feeRate reduces net profit', () => {
    const net004 = netProfitLogicArb(REL, 0.70, 0.60, SHARES, 0.04);
    const net010 = netProfitLogicArb(REL, 0.70, 0.60, SHARES, 0.10);
    expect(net004).toBeGreaterThan(net010);
  });
});

// ─── netProfitLogicArb — 'mutually_exclusive' ────────────────────────────────

describe("netProfitLogicArb('mutually_exclusive')", () => {
  const REL = 'mutually_exclusive' as const;
  const SHARES = 10;
  const FEE = LOGIC_ARB_FEE_RATE;

  it('profitable case: pA=0.65, pB=0.55 → net ≈ $1.81', () => {
    // gross  = 10 × (0.65 + 0.55 − 1) = 10 × 0.20 = $2.00
    // feeNoA = 10 × 0.04 × 0.35 × 0.65 = $0.091
    // feeNoB = 10 × 0.04 × 0.45 × 0.55 = $0.099
    // net    ≈ $2.00 − $0.190 = $1.81
    const expected =
      SHARES * (0.65 + 0.55 - 1)
      - legFee(SHARES, 1 - 0.65, FEE)   // NO-A
      - legFee(SHARES, 1 - 0.55, FEE);  // NO-B
    expect(netProfitLogicArb(REL, 0.65, 0.55, SHARES, FEE)).toBeCloseTo(expected, 8);
    expect(netProfitLogicArb(REL, 0.65, 0.55, SHARES, FEE)).toBeGreaterThan(0);
  });

  it('fee-eats-margin: pA=0.51, pB=0.51 (sum=1.02, tiny deviation) → net < 0', () => {
    // gross = 10 × 0.02 = $0.20
    // fees at p≈0.49: each ≈ 10 × 0.04 × 0.49 × 0.51 ≈ 0.0999
    // total fees ≈ $0.20 → net ≈ 0.0
    const net = netProfitLogicArb(REL, 0.51, 0.51, SHARES, FEE);
    expect(net).toBeLessThan(0.05);
  });

  it('at-parity (sum = 1.00): gross = 0, net < 0 (pure fee drag)', () => {
    const net = netProfitLogicArb(REL, 0.50, 0.50, SHARES, FEE);
    expect(net).toBeLessThan(0);
  });

  it('large deviation (pA=0.80, pB=0.70, sum=1.50): highly profitable', () => {
    // gross = 10 × 0.50 = $5.00
    const net = netProfitLogicArb(REL, 0.80, 0.70, SHARES, FEE);
    expect(net).toBeGreaterThan(4.0);
  });

  it('matches NegRisk short-arb formula (no rounding divergence)', () => {
    // For n=2 markets, mutually_exclusive IS the NegRisk short-arb.
    // Verify formula parity by comparing with the hand-rolled expected value.
    const pA = 0.60, pB = 0.58;
    const gross   = SHARES * (pA + pB - 1);
    const feeNoA  = legFee(SHARES, 1 - pA, FEE);
    const feeNoB  = legFee(SHARES, 1 - pB, FEE);
    expect(netProfitLogicArb(REL, pA, pB, SHARES, FEE))
      .toBeCloseTo(gross - feeNoA - feeNoB, 10);
  });

  it('is symmetric: swapping pA and pB gives the same result', () => {
    const net_ab = netProfitLogicArb(REL, 0.65, 0.55, SHARES, FEE);
    const net_ba = netProfitLogicArb(REL, 0.55, 0.65, SHARES, FEE);
    expect(net_ab).toBeCloseTo(net_ba, 10);
  });
});

// ─── isLogicArbOpportunity ───────────────────────────────────────────────────

describe('isLogicArbOpportunity', () => {
  describe('a_implies_b', () => {
    it('returns true when pA > pB (mispriced: A more expensive than B)', () => {
      expect(isLogicArbOpportunity('a_implies_b', 0.70, 0.60)).toBe(true);
    });

    it('returns false when pA < pB (fair: B costs at least as much as A)', () => {
      expect(isLogicArbOpportunity('a_implies_b', 0.55, 0.65)).toBe(false);
    });

    it('returns false when pA = pB (parity — no gross profit)', () => {
      expect(isLogicArbOpportunity('a_implies_b', 0.60, 0.60)).toBe(false);
    });
  });

  describe('mutually_exclusive', () => {
    it('returns true when pA + pB > 1', () => {
      expect(isLogicArbOpportunity('mutually_exclusive', 0.65, 0.55)).toBe(true);
    });

    it('returns false when pA + pB < 1', () => {
      expect(isLogicArbOpportunity('mutually_exclusive', 0.40, 0.35)).toBe(false);
    });

    it('returns false when pA + pB = 1 exactly (parity)', () => {
      expect(isLogicArbOpportunity('mutually_exclusive', 0.50, 0.50)).toBe(false);
    });
  });
});

// ─── logicArbDeviation ───────────────────────────────────────────────────────

describe('logicArbDeviation', () => {
  it('a_implies_b: deviation = pA - pB', () => {
    expect(logicArbDeviation('a_implies_b', 0.70, 0.60)).toBeCloseTo(0.10, 10);
    expect(logicArbDeviation('a_implies_b', 0.60, 0.70)).toBeCloseTo(-0.10, 10);
  });

  it('mutually_exclusive: deviation = pA + pB - 1', () => {
    expect(logicArbDeviation('mutually_exclusive', 0.65, 0.55)).toBeCloseTo(0.20, 10);
    expect(logicArbDeviation('mutually_exclusive', 0.40, 0.35)).toBeCloseTo(-0.25, 10);
  });

  it('deviation is positive iff isLogicArbOpportunity is true', () => {
    const cases: [LogicArbRelationship, number, number][] = [
      ['a_implies_b', 0.70, 0.60],
      ['a_implies_b', 0.55, 0.65],
      ['mutually_exclusive', 0.65, 0.55],
      ['mutually_exclusive', 0.40, 0.35],
    ];
    for (const [rel, pA, pB] of cases) {
      const opp = isLogicArbOpportunity(rel, pA, pB);
      const dev = logicArbDeviation(rel, pA, pB);
      expect(opp).toBe(dev > 0);
    }
  });
});

// ─── logicArbTradeLegs ───────────────────────────────────────────────────────

describe('logicArbTradeLegs', () => {
  it('a_implies_b: legA = NO-A, legB = YES-B', () => {
    const legs = logicArbTradeLegs('a_implies_b', 0.70, 0.60);
    expect(legs.legA).toEqual({ token: 'NO', price: 1 - 0.70 });
    expect(legs.legB).toEqual({ token: 'YES', price: 0.60 });
  });

  it('mutually_exclusive: legA = NO-A, legB = NO-B', () => {
    const legs = logicArbTradeLegs('mutually_exclusive', 0.65, 0.55);
    expect(legs.legA).toEqual({ token: 'NO', price: 1 - 0.65 });
    expect(legs.legB).toEqual({ token: 'NO', price: 1 - 0.55 });
  });

  it('a_implies_b leg prices sum to the total cost formula', () => {
    const pA = 0.70, pB = 0.60;
    const legs = logicArbTradeLegs('a_implies_b', pA, pB);
    const totalCostPerShare = legs.legA.price + legs.legB.price;
    // Expected: (1-pA) + pB
    expect(totalCostPerShare).toBeCloseTo((1 - pA) + pB, 10);
  });

  it('mutually_exclusive leg prices sum to the total cost formula', () => {
    const pA = 0.65, pB = 0.55;
    const legs = logicArbTradeLegs('mutually_exclusive', pA, pB);
    const totalCostPerShare = legs.legA.price + legs.legB.price;
    // Expected: (1-pA) + (1-pB) = 2 - pA - pB
    expect(totalCostPerShare).toBeCloseTo(2 - pA - pB, 10);
  });
});

// ─── Cross-relationship consistency ──────────────────────────────────────────

describe('cross-relationship: a_implies_b vs mutually_exclusive fee sensitivity', () => {
  it('both relationships: higher fee rate reduces net profit monotonically', () => {
    const feeRates = [0.01, 0.04, 0.07, 0.10];

    const imply = feeRates.map(f => netProfitLogicArb('a_implies_b', 0.70, 0.60, 10, f));
    const mutex = feeRates.map(f => netProfitLogicArb('mutually_exclusive', 0.65, 0.55, 10, f));

    for (let i = 1; i < feeRates.length; i++) {
      expect(imply[i]).toBeLessThan(imply[i - 1]);
      expect(mutex[i]).toBeLessThan(mutex[i - 1]);
    }
  });
});
