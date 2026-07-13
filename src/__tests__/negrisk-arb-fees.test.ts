/**
 * Unit tests for NegRisk arb fee-aware profit calculation.
 *
 * NegRisk invariant (source: docs/arb/arbitrage.md §9):
 *   In a Winner-Take-All event with n outcomes, Σ(YES prices) = $1.00 at fair value.
 *
 * Taker fee formula (same structure as crypto, different rate):
 *   fee = shares × feeRate × p × (1 − p)
 *
 * Two arb directions:
 *   Long arb  (Σ YES < 1): buy YES on every outcome → guaranteed $1 payout/share
 *   Short arb (Σ YES > 1): buy NO on every outcome  → guaranteed (n−1) payout/share
 *
 * Fee rate resolution:
 *   The live feeRate is fetched from CLOB API (taker_base_fee bps → / 10_000).
 *   NEGRISK_FEE_RATE (0.04) is a fallback for the politics category only.
 *   feeRateFromBps() converts raw bps to coefficient, falling back when data is absent.
 *
 * All functions under test are pure — no I/O, no mocks needed.
 * NegRiskArbService tests use an injected mock feeRateFetcher (no real HTTP calls).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NEGRISK_FEE_RATE,
  FEE_RATE_BPS_DIVISOR,
  feeForLeg,
  feeRateFromBps,
  netProfitLongArb,
  netProfitShortArb,
} from '../services/negrisk-arb-types.js';
import { NegRiskArbService } from '../services/negrisk-arb-service.js';
import type { GammaApiClient, GammaEvent } from '../clients/gamma-api.js';

// ---------------------------------------------------------------------------
// feeForLeg
// ---------------------------------------------------------------------------

describe('feeForLeg', () => {
  it('matches the formula: shares × feeRate × p × (1−p)', () => {
    // 10 shares @ p=0.30, feeRate=NEGRISK_FEE_RATE (0.04)
    // fee = 10 × 0.04 × 0.30 × 0.70 = 0.084
    expect(feeForLeg(10, 0.30)).toBeCloseTo(10 * NEGRISK_FEE_RATE * 0.30 * 0.70, 6);
  });

  it('peaks at p=0.50', () => {
    // 10 shares @ p=0.50, feeRate=NEGRISK_FEE_RATE (0.04): fee = 10 × 0.04 × 0.25 = 0.100
    expect(feeForLeg(10, 0.50)).toBeCloseTo(10 * NEGRISK_FEE_RATE * 0.50 * 0.50, 6);
    // must exceed fee at p=0.30 and p=0.70
    expect(feeForLeg(10, 0.50)).toBeGreaterThan(feeForLeg(10, 0.30));
    expect(feeForLeg(10, 0.50)).toBeGreaterThan(feeForLeg(10, 0.70));
  });

  it('approaches 0 at the extremes (p→0 or p→1)', () => {
    expect(feeForLeg(10, 0.01)).toBeLessThan(0.005);
    expect(feeForLeg(10, 0.99)).toBeLessThan(0.005);
  });

  it('scales linearly with shares', () => {
    const fee10 = feeForLeg(10, 0.40);
    const fee20 = feeForLeg(20, 0.40);
    expect(fee20).toBeCloseTo(fee10 * 2, 6);
  });

  it('respects a custom feeRate override', () => {
    // Use CRYPTO_FEE_RATE (0.07) as override — fee should be 3.5× higher
    const base  = feeForLeg(10, 0.30, NEGRISK_FEE_RATE);     // 0.042
    const crypto = feeForLeg(10, 0.30, 0.07);                  // 0.147
    expect(crypto / base).toBeCloseTo(0.07 / NEGRISK_FEE_RATE, 4);
  });
});

// ---------------------------------------------------------------------------
// netProfitLongArb
// ---------------------------------------------------------------------------

describe('netProfitLongArb', () => {
  it('fires: 4-outcome event with clear underpricing (Σ YES = 0.92)', () => {
    // From arbitrage.md §9.3 example:
    //   A: 0.30, B: 0.28, C: 0.22, D: 0.12  →  sum = 0.92
    // gross  = (1 − 0.92) × 10 = $0.80
    // fees   = Σ feeForLeg(10, p) for each p → small (< $0.15)
    // net    > $0.65 → well above $0.05 threshold
    const net = netProfitLongArb([0.30, 0.28, 0.22, 0.12], 10);
    expect(net).toBeGreaterThan(0.05);
    expect(net).toBeLessThan(0.80); // cannot exceed gross
  });

  it('fires: 3-outcome with moderate underpricing (Σ YES = 0.85)', () => {
    // A: 0.50, B: 0.20, C: 0.15  →  sum = 0.85
    // gross = 0.15 × 10 = $1.50 — generous margin
    const net = netProfitLongArb([0.50, 0.20, 0.15], 10);
    expect(net).toBeGreaterThan(0.05);
  });

  it('does NOT fire: near-efficient market where fees eat the margin (Σ YES = 0.995)', () => {
    // Prices nearly sum to 1 → tiny gross profit eaten by fees
    // gross = 0.005 × 10 = $0.05 — fees will exceed this
    const net = netProfitLongArb([0.33, 0.34, 0.325], 10);
    // yesSum ≈ 0.995, gross ≈ $0.05; fees > $0.05
    expect(net).toBeLessThan(0.05);
  });

  it('does NOT fire: sum exactly = 1 (fair value) — all profit is negative after fees', () => {
    // gross = 0; only fees, so net < 0
    const net = netProfitLongArb([0.50, 0.30, 0.20], 10);
    expect(0.50 + 0.30 + 0.20).toBeCloseTo(1.0, 6);
    expect(net).toBeLessThan(0);
  });

  it('edge case: 2-outcome market (Σ YES = 0.90)', () => {
    // Standard binary that happens to be underpriced (unusual but valid)
    // gross = 0.10 × 10 = $1.00
    const net = netProfitLongArb([0.40, 0.50], 10);
    expect(0.40 + 0.50).toBeLessThan(1);
    expect(net).toBeGreaterThan(0.05);
  });

  it('returns zero gross (minus fees) when all YES prices are equal and sum to 1', () => {
    // 5 equal outcomes @ 0.20 each → Σ = 1.00 exactly
    const net = netProfitLongArb([0.20, 0.20, 0.20, 0.20, 0.20], 10);
    expect(net).toBeLessThan(0); // fees make it a loss
  });

  it('scales linearly with share count', () => {
    const net10 = netProfitLongArb([0.30, 0.28, 0.22, 0.12], 10);
    const net20 = netProfitLongArb([0.30, 0.28, 0.22, 0.12], 20);
    expect(net20).toBeCloseTo(net10 * 2, 6);
  });

  it('equals gross profit when feeRate is zero', () => {
    // yesPrices sum to 0.92 → gross = 0.08 × 10 = 0.80 exactly
    const net = netProfitLongArb([0.30, 0.28, 0.22, 0.12], 10, 0);
    expect(net).toBeCloseTo(0.80, 6);
  });
});

// ---------------------------------------------------------------------------
// netProfitShortArb
// ---------------------------------------------------------------------------

describe('netProfitShortArb', () => {
  it('fires: 5-outcome event with overpricing (Σ YES = 1.08)', () => {
    // From arbitrage.md §9.2 example:
    //   Macron: 0.45, Le Pen: 0.35, Mélenchon: 0.15, Zemmour: 0.08, Other: 0.05
    //   sum = 1.08
    // NO prices: 0.55, 0.65, 0.85, 0.92, 0.95  →  Σ(NO) = 3.92
    // cost    = 3.92 × 10 = $39.20
    // payout  = (5−1) × 10 = $40.00
    // gross   = $0.80, minus small fees
    const net = netProfitShortArb([0.45, 0.35, 0.15, 0.08, 0.05], 10);
    expect(net).toBeGreaterThan(0.05);
    expect(net).toBeLessThan(0.80); // cannot exceed gross
  });

  it('fires: 3-outcome with overpricing (Σ YES = 1.05)', () => {
    // gross = (Σ(YES) − 1) × shares = 0.05 × 10 = $0.50
    const net = netProfitShortArb([0.50, 0.30, 0.25], 10);
    expect(0.50 + 0.30 + 0.25).toBeCloseTo(1.05, 6);
    expect(net).toBeGreaterThan(0.05);
  });

  it('does NOT fire: Σ YES = 1.002 — fees exceed the gross margin', () => {
    // Almost fair: gross = 0.002 × 10 = $0.02; fees will wipe it out
    const net = netProfitShortArb([0.34, 0.33, 0.332], 10);
    expect(net).toBeLessThan(0.05);
  });

  it('does NOT fire: Σ YES exactly = 1 (fair value)', () => {
    // gross = 0, only fees → net < 0
    const net = netProfitShortArb([0.50, 0.30, 0.20], 10);
    expect(net).toBeLessThan(0);
  });

  it('edge case: 2-outcome market (Σ YES = 1.08)', () => {
    // Both candidates overpriced: payout = (2−1) × 10 = $10
    // cost = (1−0.58) + (1−0.50) = 0.42 + 0.50 = 0.92 → 0.92 × 10 = $9.20
    // gross = $0.80
    const net = netProfitShortArb([0.58, 0.50], 10);
    expect(0.58 + 0.50).toBeCloseTo(1.08, 6);
    expect(net).toBeGreaterThan(0.05);
  });

  it('scales linearly with share count', () => {
    const net10 = netProfitShortArb([0.45, 0.35, 0.15, 0.08, 0.05], 10);
    const net20 = netProfitShortArb([0.45, 0.35, 0.15, 0.08, 0.05], 20);
    expect(net20).toBeCloseTo(net10 * 2, 6);
  });

  it('equals gross profit when feeRate is zero', () => {
    // Σ(YES) = 1.08 → gross = (Σ(YES) − 1) × shares = 0.08 × 10 = 0.80
    const net = netProfitShortArb([0.45, 0.35, 0.15, 0.08, 0.05], 10, 0);
    expect(net).toBeCloseTo(0.80, 6);
  });
});

// ---------------------------------------------------------------------------
// Cross-direction consistency
// ---------------------------------------------------------------------------

describe('Long vs Short arb — mutually exclusive profit conditions', () => {
  it('only long fires when Σ YES < 1', () => {
    const yesPrices = [0.30, 0.28, 0.22, 0.12]; // sum = 0.92
    expect(netProfitLongArb(yesPrices, 10)).toBeGreaterThan(0.05);
    expect(netProfitShortArb(yesPrices, 10)).toBeLessThan(0); // would be a loss
  });

  it('only short fires when Σ YES > 1', () => {
    const yesPrices = [0.45, 0.35, 0.15, 0.08, 0.05]; // sum = 1.08
    expect(netProfitShortArb(yesPrices, 10)).toBeGreaterThan(0.05);
    expect(netProfitLongArb(yesPrices, 10)).toBeLessThan(0); // would be a loss
  });

  it('neither fires at fair value (Σ YES = 1)', () => {
    const yesPrices = [0.50, 0.30, 0.20]; // sum = 1.00
    expect(netProfitLongArb(yesPrices, 10)).toBeLessThan(0.05);
    expect(netProfitShortArb(yesPrices, 10)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// feeRateFromBps — pure conversion function
// ---------------------------------------------------------------------------

describe('feeRateFromBps', () => {
  it('converts 1000 bps → 0.10 (sports category, observed in production)', () => {
    expect(feeRateFromBps(1000)).toBeCloseTo(1000 / FEE_RATE_BPS_DIVISOR, 6);
    expect(feeRateFromBps(1000)).toBeCloseTo(0.10, 6);
  });

  it('converts 700 bps → 0.07 (matches CRYPTO_FEE_RATE for cross-validation)', () => {
    expect(feeRateFromBps(700)).toBeCloseTo(0.07, 6);
  });

  it('converts 400 bps → 0.04 (politics category — matches NEGRISK_FEE_RATE default)', () => {
    expect(feeRateFromBps(400)).toBeCloseTo(NEGRISK_FEE_RATE, 6);
  });

  it('falls back to NEGRISK_FEE_RATE when bps is null (fetch failed)', () => {
    expect(feeRateFromBps(null)).toBe(NEGRISK_FEE_RATE);
  });

  it('falls back to NEGRISK_FEE_RATE when bps is 0 (settled/exempt market)', () => {
    // taker_base_fee=0 on settled markets should not be treated as "free"
    expect(feeRateFromBps(0)).toBe(NEGRISK_FEE_RATE);
  });

  it('falls back to NEGRISK_FEE_RATE when bps is negative', () => {
    expect(feeRateFromBps(-1)).toBe(NEGRISK_FEE_RATE);
  });

  it('respects a custom fallback value', () => {
    const customFallback = 0.05;
    expect(feeRateFromBps(null, customFallback)).toBe(customFallback);
    expect(feeRateFromBps(0, customFallback)).toBe(customFallback);
  });

  it('is the exact inverse of × FEE_RATE_BPS_DIVISOR', () => {
    const bps = 350;
    expect(feeRateFromBps(bps) * FEE_RATE_BPS_DIVISOR).toBeCloseTo(bps, 6);
  });
});

// ---------------------------------------------------------------------------
// NegRiskArbService — fee rate resolution via injected fetcher
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock GammaApiClient that returns one multi-outcome event
 * whose markets have the given YES prices.
 */
function makeMockGammaApi(yesPrices: number[]): GammaApiClient {
  const markets = yesPrices.map((yesPrice, i) => ({
    id:            `m${i}`,
    conditionId:   `cid-${i}`,
    slug:          `outcome-${i}`,
    question:      `Will outcome ${i} happen?`,
    outcomes:      ['Yes', 'No'],
    outcomePrices: [yesPrice, 1 - yesPrice],
    volume:        100_000,
    liquidity:     50_000,
    endDate:       new Date(Date.now() + 86_400_000),
    active:        true,
    closed:        false,
  }));

  const event: GammaEvent = {
    id:      'evt-1',
    slug:    'test-election',
    title:   'Test Election',
    markets,
  };

  return {
    getEvents: vi.fn().mockResolvedValue([event]),
    getMarkets: vi.fn().mockResolvedValue([]),
    getMarketBySlug: vi.fn(),
    getMarketByConditionId: vi.fn(),
    getEventBySlug: vi.fn(),
    getEventById: vi.fn(),
    getTrendingMarkets: vi.fn(),
  } as unknown as GammaApiClient;
}

describe('NegRiskArbService — live feeRate fetched from injected fetcher', () => {
  it('uses the live feeRate (from fetcher) instead of the hardcoded fallback', async () => {
    // Sports market: 1000 bps = 0.10 — much higher than NEGRISK_FEE_RATE (0.04)
    const liveBps = 1000;
    const liveFeeRate = liveBps / FEE_RATE_BPS_DIVISOR; // 0.10
    const mockFetcher = vi.fn().mockResolvedValue(liveBps);

    // Mispriced event: Σ(YES) = 0.92 (long arb opportunity)
    const yesPrices = [0.30, 0.28, 0.22, 0.12];
    const gammaApi = makeMockGammaApi(yesPrices);

    const svc = new NegRiskArbService(gammaApi, mockFetcher);

    const signals: unknown[] = [];
    svc.on('signal', s => signals.push(s));

    // Only run one scan, then stop immediately
    await svc.start();
    svc.stop();

    // Fetcher must have been called with the first market's conditionId
    expect(mockFetcher).toHaveBeenCalledWith('cid-0');

    // Signal should reflect the live fee rate (0.10), not the fallback (0.04)
    // net profit with live fee (0.10) will be LOWER than with fallback (0.04)
    if (signals.length > 0) {
      const sig = signals[0] as { netProfitUSD: number };
      const netWithLiveFee     = netProfitLongArb(yesPrices, 10, liveFeeRate);
      const netWithFallbackFee = netProfitLongArb(yesPrices, 10, NEGRISK_FEE_RATE);
      // Live fee (0.10) is higher → net profit is lower
      expect(sig.netProfitUSD).toBeCloseTo(netWithLiveFee, 4);
      expect(netWithLiveFee).toBeLessThan(netWithFallbackFee);
    }
  });

  it('emits feeRateFallback event and uses NEGRISK_FEE_RATE when fetcher returns null', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(null); // simulates fetch failure

    const yesPrices = [0.30, 0.28, 0.22, 0.12]; // Σ = 0.92, long arb
    const gammaApi = makeMockGammaApi(yesPrices);

    const svc = new NegRiskArbService(gammaApi, mockFetcher);

    const fallbackWarnings: unknown[] = [];
    svc.on('feeRateFallback', w => fallbackWarnings.push(w));

    const signals: unknown[] = [];
    svc.on('signal', s => signals.push(s));

    await svc.start();
    svc.stop();

    // Fallback warning must have been emitted
    expect(fallbackWarnings.length).toBeGreaterThan(0);
    const warning = fallbackWarnings[0] as { conditionId: string; reason: string; fallback: number };
    expect(warning.conditionId).toBe('cid-0');
    expect(warning.reason).toBe('fetch failed');
    expect(warning.fallback).toBe(NEGRISK_FEE_RATE);

    // Signal profit should match the fallback fee (0.04)
    if (signals.length > 0) {
      const sig = signals[0] as { netProfitUSD: number };
      expect(sig.netProfitUSD).toBeCloseTo(
        netProfitLongArb(yesPrices, 10, NEGRISK_FEE_RATE),
        4,
      );
    }
  });

  it('emits feeRateFallback when fetcher returns 0 (settled market with zero fee)', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(0);

    const yesPrices = [0.45, 0.35, 0.25]; // Σ = 1.05, short arb
    const gammaApi = makeMockGammaApi(yesPrices);

    const svc = new NegRiskArbService(gammaApi, mockFetcher);

    const fallbackWarnings: unknown[] = [];
    svc.on('feeRateFallback', w => fallbackWarnings.push(w));

    await svc.start();
    svc.stop();

    expect(fallbackWarnings.length).toBeGreaterThan(0);
    const warning = fallbackWarnings[0] as { reason: string };
    expect(warning.reason).toBe('zero fee returned');
  });

  it('caches the fetched fee so fetcher is called only once per conditionId per TTL', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(400); // 400 bps = 0.04

    const yesPrices = [0.30, 0.28, 0.22, 0.12];
    const gammaApi = makeMockGammaApi(yesPrices);

    const svc = new NegRiskArbService(gammaApi, mockFetcher);
    svc.updateConfig({ scanIntervalMs: 0 }); // scan immediately

    // Run two scans manually
    await (svc as unknown as { scan(): Promise<void> })['scan']();
    await (svc as unknown as { scan(): Promise<void> })['scan']();
    svc.stop();

    // Even though we scanned twice, fetcher should only be called once (cache hit)
    expect(mockFetcher).toHaveBeenCalledTimes(1);
  });
});
