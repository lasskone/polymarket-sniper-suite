/**
 * NegRisk Arbitrage Service
 *
 * 多结果市场套利服务 (Winner-Take-All Events)
 *
 * Detects fee-adjusted arbitrage opportunities in Polymarket NegRisk events by
 * polling the Gamma API and checking whether Σ(YES prices) deviates enough
 * from $1.00 to yield guaranteed profit after taker fees.
 *
 * Detection-only in this version — no order execution is attempted.
 * Live execution requires CTF/NegRisk adapter contract integration.
 *
 * Per-market fee rates are fetched from the Polymarket CLOB API
 * (GET /markets/{conditionId} → taker_base_fee, integer, basis points).
 * The fallback constant NEGRISK_FEE_RATE is used only when the fetch fails,
 * and a 'feeRateFallback' event is emitted so callers can log a warning.
 *
 * Events emitted:
 *   'started'         — service began polling
 *   'scanned'         — one scan cycle completed (NegRiskScanResult payload)
 *   'signal'          — profitable arb detected (NegRiskArbSignal payload)
 *   'feeRateFallback' — live fee fetch failed; fallback used ({ conditionId, reason })
 *   'stopped'         — service stopped cleanly
 *   'error'           — Error payload; caller should decide whether to restart
 *
 * Usage:
 *   const svc = new NegRiskArbService(sdk.gammaApi);
 *   svc.on('feeRateFallback', w => console.warn('fee fallback', w));
 *   svc.on('signal', sig => console.log(sig));
 *   await svc.start();
 *
 * For testing, inject a custom feeRateFetcher:
 *   const svc = new NegRiskArbService(mockGammaApi, async () => 400);  // 400 bps = 0.04
 */

import { EventEmitter } from 'events';
import type { GammaApiClient } from '../clients/gamma-api.js';
import {
  NEGRISK_FEE_RATE,
  feeRateFromBps,
  netProfitLongArb,
  netProfitShortArb,
  type NegRiskArbConfig,
  type NegRiskArbSignal,
  type NegRiskScanResult,
} from './negrisk-arb-types.js';

// ============= CLOB Fee Fetcher =============

/** CLOB API base URL (public, no auth required for GET). */
const CLOB_BASE = 'https://clob.polymarket.com';

/**
 * Minimal shape of the CLOB `/markets/{conditionId}` response we care about.
 * taker_base_fee is in basis points (integer, e.g. 1000 = 10%).
 */
interface ClobMarketFeeInfo {
  taker_base_fee: number;
}

/**
 * Cache entry for a fetched fee rate (basis points).
 * Avoids hammering the CLOB API on every 30-second scan cycle.
 */
interface FeeCacheEntry {
  bps: number;
  expiresAt: number;
}

/** Default fee cache TTL: 10 minutes. */
const FEE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Production fee-rate fetcher: calls the Polymarket CLOB API and returns
 * `taker_base_fee` (integer, basis points) for the given conditionId.
 *
 * Returns `null` on any fetch error so the caller can apply the fallback.
 */
async function defaultFetchFeeBps(conditionId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/markets/${conditionId}`);
    if (!res.ok) return null;
    const data = (await res.json()) as ClobMarketFeeInfo;
    const bps = data?.taker_base_fee;
    return typeof bps === 'number' && bps > 0 ? bps : null;
  } catch {
    return null;
  }
}

// ============= Service Config Defaults =============

const DEFAULT_CONFIG: NegRiskArbConfig = {
  shares:          10,
  minNetProfitUSD: 0.05,
  scanIntervalMs:  30_000,
  minOutcomes:     3,
  maxOutcomes:     25,
  feeRate:         NEGRISK_FEE_RATE,
};

// ============= Service =============

/**
 * Dependency-injectable fee-rate fetcher type.
 * Returns the raw taker_base_fee in basis points, or null on failure.
 */
export type FeeRateFetcher = (conditionId: string) => Promise<number | null>;

export class NegRiskArbService extends EventEmitter {
  private cfg: NegRiskArbConfig = { ...DEFAULT_CONFIG };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** In-memory fee cache: conditionId → { bps, expiresAt } */
  private feeCache = new Map<string, FeeCacheEntry>();

  /**
   * @param gammaApi       - Reuse the SDK's already-initialised Gamma API client
   *                         (access via `sdk.gammaApi`, public readonly on PolymarketSDK).
   * @param feeRateFetcher - Optional injectable fee fetcher (for testing or custom logic).
   *                         Defaults to a live call to `https://clob.polymarket.com`.
   *                         Returns taker_base_fee in basis points, or null on failure.
   */
  constructor(
    private readonly gammaApi: GammaApiClient,
    private readonly feeRateFetcher: FeeRateFetcher = defaultFetchFeeBps,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  updateConfig(partial: Partial<NegRiskArbConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  getConfig(): Readonly<NegRiskArbConfig> {
    return { ...this.cfg };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit('started');

    try {
      await this.scan();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.feeCache.clear();
    this.emit('stopped');
  }

  // --------------------------------------------------------------------------
  // Polling loop
  // --------------------------------------------------------------------------

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.scan();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      this.scheduleNext();
    }, this.cfg.scanIntervalMs);
  }

  // --------------------------------------------------------------------------
  // Fee resolution
  // --------------------------------------------------------------------------

  /**
   * Resolves the fee-rate coefficient for a given conditionId.
   *
   * Order of precedence:
   *   1. In-memory cache (TTL = FEE_CACHE_TTL_MS)
   *   2. Live CLOB API fetch → taker_base_fee / 10_000
   *   3. Fallback: NEGRISK_FEE_RATE (emits 'feeRateFallback' event with reason)
   */
  private async resolveFeeRate(conditionId: string): Promise<number> {
    // Cache hit?
    const cached = this.feeCache.get(conditionId);
    if (cached && Date.now() < cached.expiresAt) {
      return feeRateFromBps(cached.bps, this.cfg.feeRate);
    }

    // Live fetch
    const bps = await this.feeRateFetcher(conditionId);

    if (bps !== null && bps > 0) {
      // Cache the raw bps value
      this.feeCache.set(conditionId, { bps, expiresAt: Date.now() + FEE_CACHE_TTL_MS });
      return feeRateFromBps(bps, this.cfg.feeRate);
    }

    // Fallback — emit warning event so callers can log it
    this.emit('feeRateFallback', {
      conditionId,
      reason:   bps === null ? 'fetch failed' : 'zero fee returned',
      fallback: this.cfg.feeRate,
    });
    return this.cfg.feeRate;
  }

  // --------------------------------------------------------------------------
  // Core scan
  // --------------------------------------------------------------------------

  private async scan(): Promise<void> {
    const events = await this.gammaApi.getEvents({ active: true, limit: 50 });

    // NegRisk events have multiple binary outcome markets grouped together.
    // Filter to events with enough markets to qualify as multi-outcome NegRisk.
    const candidates = events.filter(
      e =>
        e.markets.length >= this.cfg.minOutcomes &&
        e.markets.length <= this.cfg.maxOutcomes,
    );

    const scanResult: NegRiskScanResult = {
      eventsTotal:   events.length,
      negRiskEvents: candidates.length,
      scannedAt:     Date.now(),
    };
    this.emit('scanned', scanResult);

    for (const event of candidates) {
      // Only include active, non-closed markets with valid YES prices.
      // outcomePrices[0] = YES price, outcomePrices[1] = NO price.
      const validMarkets = event.markets.filter(
        m =>
          m.active &&
          !m.closed &&
          Array.isArray(m.outcomePrices) &&
          m.outcomePrices.length >= 2 &&
          m.outcomePrices[0] > 0 &&
          m.outcomePrices[0] < 1,
      );

      if (validMarkets.length < this.cfg.minOutcomes) continue;

      // Fetch the real taker fee for this event's first market.
      // All outcome markets in the same NegRisk event share one fee tier.
      const firstConditionId = validMarkets[0].conditionId;
      const feeRate = await this.resolveFeeRate(firstConditionId);

      const yesPrices = validMarkets.map(m => m.outcomePrices[0]);
      const yesSum    = yesPrices.reduce((acc, p) => acc + p, 0);

      // ── Long arb: Σ(YES) < 1 → buy all YES ──────────────────────────────
      if (yesSum < 1) {
        const net = netProfitLongArb(yesPrices, this.cfg.shares, feeRate);
        if (net >= this.cfg.minNetProfitUSD) {
          const signal: NegRiskArbSignal = {
            eventId:      event.id,
            eventTitle:   event.title,
            direction:    'long',
            yesSum,
            deviation:    1 - yesSum,
            netProfitUSD: net,
            shares:       this.cfg.shares,
            outcomeCount: validMarkets.length,
            marketIds:    validMarkets.map(m => m.conditionId),
          };
          this.emit('signal', signal);
        }
      }

      // ── Short arb: Σ(YES) > 1 → buy all NO ──────────────────────────────
      if (yesSum > 1) {
        const net = netProfitShortArb(yesPrices, this.cfg.shares, feeRate);
        if (net >= this.cfg.minNetProfitUSD) {
          const signal: NegRiskArbSignal = {
            eventId:      event.id,
            eventTitle:   event.title,
            direction:    'short',
            yesSum,
            deviation:    yesSum - 1,
            netProfitUSD: net,
            shares:       this.cfg.shares,
            outcomeCount: validMarkets.length,
            marketIds:    validMarkets.map(m => m.conditionId),
          };
          this.emit('signal', signal);
        }
      }
    }
  }
}
