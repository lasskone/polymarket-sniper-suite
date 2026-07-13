/**
 * Unit tests for dip-arb dynamic position sizing pure functions.
 *
 * All functions are pure (no I/O) so tests are deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTargetNotional,
  capNotional,
  notionalToShares,
  computeShares,
  MIN_SHARES,
} from '../services/dip-arb-sizing.js';

// ─── computeTargetNotional ────────────────────────────────────────────────────

describe('computeTargetNotional', () => {
  it('returns 2% of 1000 as 20', () => {
    expect(computeTargetNotional(1000, 2)).toBeCloseTo(20, 6);
  });

  it('returns 5% of 500 as 25', () => {
    expect(computeTargetNotional(500, 5)).toBeCloseTo(25, 6);
  });

  it('returns 0 when balance is 0', () => {
    expect(computeTargetNotional(0, 2)).toBe(0);
  });

  it('returns 0 when pct is 0', () => {
    expect(computeTargetNotional(1000, 0)).toBe(0);
  });

  it('returns 0 when balance is negative', () => {
    expect(computeTargetNotional(-100, 2)).toBe(0);
  });

  it('returns 0 when pct is negative', () => {
    expect(computeTargetNotional(1000, -5)).toBe(0);
  });

  it('handles fractional pct correctly', () => {
    expect(computeTargetNotional(1000, 0.5)).toBeCloseTo(5, 6);
  });
});

// ─── capNotional ─────────────────────────────────────────────────────────────

describe('capNotional', () => {
  it('does not cap when target < max', () => {
    expect(capNotional(20, 100)).toBe(20);
  });

  it('caps when target > max', () => {
    expect(capNotional(20, 15)).toBe(15);
  });

  it('caps at exact boundary', () => {
    expect(capNotional(20, 20)).toBe(20);
  });

  it('caps 0 correctly', () => {
    expect(capNotional(0, 100)).toBe(0);
  });

  it('min(target, max) is symmetric in expected direction', () => {
    expect(capNotional(50, 30)).toBe(30);
    expect(capNotional(30, 50)).toBe(30);
  });
});

// ─── notionalToShares ────────────────────────────────────────────────────────

describe('notionalToShares', () => {
  it('floor(20 / 0.97) = 20', () => {
    // 20 / 0.97 = 20.618... → floor = 20
    expect(notionalToShares(20, 0.97)).toBe(20);
  });

  it('floor(9.7 / 0.97) = 10', () => {
    expect(notionalToShares(9.7, 0.97)).toBe(10);
  });

  it('returns MIN_SHARES when notional is too small', () => {
    // 0.5 / 0.97 < 1 → clamp to MIN_SHARES
    expect(notionalToShares(0.5, 0.97)).toBe(MIN_SHARES);
  });

  it('returns MIN_SHARES when notional is 0', () => {
    expect(notionalToShares(0, 0.97)).toBe(MIN_SHARES);
  });

  it('returns MIN_SHARES when sumTarget is 0', () => {
    expect(notionalToShares(100, 0)).toBe(MIN_SHARES);
  });

  it('returns MIN_SHARES when notional is negative', () => {
    expect(notionalToShares(-10, 0.97)).toBe(MIN_SHARES);
  });

  it('handles large notionals correctly', () => {
    // 1000 / 0.97 = 1030.9... → floor = 1030
    expect(notionalToShares(1000, 0.97)).toBe(1030);
  });

  it('works with sumTarget = 0.96 (SOL)', () => {
    // 96 / 0.96 = 100 exactly
    expect(notionalToShares(96, 0.96)).toBe(100);
  });
});

// ─── computeShares (all-in-one) ───────────────────────────────────────────────

describe('computeShares', () => {
  it('2% of 1000, cap 100, sumTarget 0.97 → 20 shares', () => {
    // target = 20, cap 20 (under 100), shares = floor(20/0.97) = 20
    expect(computeShares(1000, 2, 100, 0.97)).toBe(20);
  });

  it('cap is applied when target exceeds max', () => {
    // 10% of 1000 = 100, cap 50 → floor(50/0.97) = 51
    expect(computeShares(1000, 10, 50, 0.97)).toBe(51);
  });

  it('balance 0 → MIN_SHARES', () => {
    expect(computeShares(0, 2, 100, 0.97)).toBe(MIN_SHARES);
  });

  it('pct 0 → MIN_SHARES', () => {
    expect(computeShares(1000, 0, 100, 0.97)).toBe(MIN_SHARES);
  });

  it('tiny balance under 1 share threshold → MIN_SHARES', () => {
    // 2% of 10 = 0.20, floor(0.20/0.97) = 0 → MIN_SHARES
    expect(computeShares(10, 2, 100, 0.97)).toBe(MIN_SHARES);
  });

  it('exact boundary: notional exactly covers 1 share', () => {
    // 2% of 48.5 = 0.97, floor(0.97/0.97) = 1 = MIN_SHARES
    expect(computeShares(48.5, 2, 100, 0.97)).toBe(1);
  });

  it('real-world scenario: $500 wallet, 2%, cap $100, sumTarget 0.97', () => {
    // target = 10, cap 10, shares = floor(10/0.97) = 10
    expect(computeShares(500, 2, 100, 0.97)).toBe(10);
  });
});

// ─── Per-coin sumTarget differentiation ──────────────────────────────────────
// Verifies that SOL (0.96) produces a different (higher) share count than
// ETH/BTC (0.97) because the per-share cost is lower, so more shares fit.

describe('per-coin sumTarget differentiation', () => {
  const BALANCE   = 1000;
  const PCT       = 2;       // 2% → $20 notional
  const CAP       = 100;

  it('ETH (sumTarget 0.97) → floor(20 / 0.97) = 20 shares', () => {
    expect(computeShares(BALANCE, PCT, CAP, 0.97)).toBe(20);
  });

  it('BTC (sumTarget 0.97) → same as ETH: 20 shares', () => {
    expect(computeShares(BALANCE, PCT, CAP, 0.97)).toBe(20);
  });

  it('SOL (sumTarget 0.96) → floor(20 / 0.96) = 20 shares — still 20 but different intermediate', () => {
    // floor(20 / 0.96) = floor(20.833) = 20
    expect(computeShares(BALANCE, PCT, CAP, 0.96)).toBe(20);
  });

  it('SOL produces more shares than ETH when notional is near a threshold', () => {
    // At $19.20: floor(19.20 / 0.96) = 20, floor(19.20 / 0.97) = 19
    expect(computeShares(960, PCT, CAP, 0.96)).toBe(20);  // SOL: floor(19.2 / 0.96) = 20
    expect(computeShares(960, PCT, CAP, 0.97)).toBe(19);  // ETH: floor(19.2 / 0.97) = 19
  });

  it('SOL sumTarget never produces fewer shares than ETH for the same notional', () => {
    // Lower cost per share-pair → equal or more shares
    const sharesETH = computeShares(BALANCE, PCT, CAP, 0.97);
    const sharesSOL = computeShares(BALANCE, PCT, CAP, 0.96);
    expect(sharesSOL).toBeGreaterThanOrEqual(sharesETH);
  });
});
