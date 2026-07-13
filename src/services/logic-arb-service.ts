/**
 * Logic / Correlated-Markets Arbitrage Service
 *
 * 逻辑套利服务 — detection-only
 *
 * Polls `correlated_market_pairs` from Supabase, fetches current YES prices for
 * both markets via the Gamma API, and emits a 'signal' event whenever a pair's
 * fee-adjusted net profit clears minNetProfitUSD.
 *
 * Fee resolution follows the same cache+fallback pattern as NegRiskArbService:
 *   1. In-memory cache (TTL = FEE_CACHE_TTL_MS, keyed by conditionId)
 *   2. Live CLOB API call → taker_base_fee (integer, basis points)
 *   3. Fallback: LOGIC_ARB_FEE_RATE (emits 'feeRateFallback' with reason)
 *
 * Events emitted:
 *   'started'         — service began polling
 *   'scanned'         — one scan cycle completed (LogicArbScanResult payload)
 *   'signal'          — profitable arb detected (LogicArbSignal payload)
 *   'feeRateFallback' — live fee fetch failed; fallback used ({ conditionId, reason, fallback })
 *   'stopped'         — service stopped cleanly
 *   'error'           — Error payload; caller should decide whether to restart
 *
 * Usage:
 *   const svc = new LogicArbService(sdk.gammaApi, supabaseClient);
 *   svc.on('signal', sig => console.log(sig));
 *   await svc.start();
 *
 * For testing, inject a custom feeRateFetcher:
 *   const svc = new LogicArbService(mockGammaApi, mockSupabase, async () => 400);
 */

import { EventEmitter } from 'events';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GammaApiClient } from '../clients/gamma-api.js';
import type { Database } from '../../modules/shared/database.types.js';
import {
  LOGIC_ARB_FEE_RATE,
  feeRateFromBps,
  isLogicArbOpportunity,
  logicArbDeviation,
  logicArbTradeLegs,
  netProfitLogicArb,
  type LogicArbConfig,
  type LogicArbSignal,
  type LogicArbScanResult,
} from './logic-arb-types.js';

// ============= CLOB Fee Fetcher =============

/** CLOB API base URL (public, no auth required for GET). */
const CLOB_BASE = 'https://clob.polymarket.com';

/** Minimal shape of the CLOB `/markets/{conditionId}` response. */
interface ClobMarketFeeInfo {
  taker_base_fee: number;
}

/** Cache entry for a fetched fee rate (basis points). */
interface FeeCacheEntry {
  bps: number;
  expiresAt: number;
}

/** Fee cache TTL: 10 minutes. */
const FEE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Production fee-rate fetcher. Returns `taker_base_fee` (basis points) for a
 * given conditionId, or null on any fetch/parse error.
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

const DEFAULT_CONFIG: LogicArbConfig = {
  shares:          10,
  minNetProfitUSD: 0.05,
  scanIntervalMs:  60_000,
  feeRate:         LOGIC_ARB_FEE_RATE,
};

// ============= Service =============

/**
 * Dependency-injectable fee-rate fetcher.
 * Returns taker_base_fee in basis points, or null on failure.
 */
export type FeeRateFetcher = (conditionId: string) => Promise<number | null>;

/** Row type for the correlated_market_pairs table. */
type CorrelatedPairRow =
  Database['public']['Tables']['correlated_market_pairs']['Row'];

export class LogicArbService extends EventEmitter {
  private cfg: LogicArbConfig = { ...DEFAULT_CONFIG };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** In-memory fee cache: conditionId → { bps, expiresAt } */
  private feeCache = new Map<string, FeeCacheEntry>();

  /**
   * @param gammaApi       - Gamma API client for market price lookups.
   * @param supabase       - Supabase client for reading correlated_market_pairs.
   * @param feeRateFetcher - Optional injectable fee fetcher (for testing).
   *                         Defaults to a live call to clob.polymarket.com.
   */
  constructor(
    private readonly gammaApi: GammaApiClient,
    private readonly supabase: SupabaseClient<Database>,
    private readonly feeRateFetcher: FeeRateFetcher = defaultFetchFeeBps,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  updateConfig(partial: Partial<LogicArbConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  getConfig(): Readonly<LogicArbConfig> {
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
  // Fee resolution (identical pattern to NegRiskArbService)
  // --------------------------------------------------------------------------

  /**
   * Resolves the fee-rate coefficient for a given conditionId.
   *
   * Order of precedence:
   *   1. In-memory cache (TTL = FEE_CACHE_TTL_MS)
   *   2. Live CLOB API fetch → taker_base_fee / 10_000
   *   3. Fallback: cfg.feeRate (emits 'feeRateFallback' with reason)
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
      this.feeCache.set(conditionId, { bps, expiresAt: Date.now() + FEE_CACHE_TTL_MS });
      return feeRateFromBps(bps, this.cfg.feeRate);
    }

    // Fallback
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
    // Load active pairs from Supabase.
    const { data: pairs, error } = await this.supabase
      .from('correlated_market_pairs')
      .select('*')
      .eq('active', true);

    if (error) {
      throw new Error(`LogicArbService: failed to fetch pairs: ${error.message}`);
    }

    const pairsTotal = pairs?.length ?? 0;
    let pairsScanned = 0;

    for (const pair of (pairs ?? []) as CorrelatedPairRow[]) {
      // Fetch prices for both markets in parallel.
      const [marketA, marketB] = await Promise.all([
        this.gammaApi.getMarketByConditionId(pair.market_a_condition_id),
        this.gammaApi.getMarketByConditionId(pair.market_b_condition_id),
      ]);

      // Skip if either market is unavailable or has no valid price.
      if (!marketA || !marketB) continue;

      const priceA = marketA.outcomePrices?.[0];
      const priceB = marketB.outcomePrices?.[0];

      if (
        typeof priceA !== 'number' || priceA <= 0 || priceA >= 1 ||
        typeof priceB !== 'number' || priceB <= 0 || priceB >= 1
      ) continue;

      pairsScanned++;

      // Check for mispricing.
      if (!isLogicArbOpportunity(pair.relationship, priceA, priceB)) continue;

      // Resolve live fee rate (uses market A's conditionId — both markets in a
      // logically-related pair typically share the same event and fee tier).
      const feeRate = await this.resolveFeeRate(pair.market_a_condition_id);

      // Compute fee-adjusted net profit.
      const net = netProfitLogicArb(
        pair.relationship,
        priceA,
        priceB,
        this.cfg.shares,
        feeRate,
      );

      if (net < this.cfg.minNetProfitUSD) continue;

      const signal: LogicArbSignal = {
        pairId:              pair.id,
        marketAConditionId:  pair.market_a_condition_id,
        marketBConditionId:  pair.market_b_condition_id,
        marketASlug:         pair.market_a_slug,
        marketBSlug:         pair.market_b_slug,
        relationship:        pair.relationship,
        priceA,
        priceB,
        deviation:    logicArbDeviation(pair.relationship, priceA, priceB),
        netProfitUSD: net,
        shares:       this.cfg.shares,
        feeRate,
        trade:        logicArbTradeLegs(pair.relationship, priceA, priceB),
      };

      this.emit('signal', signal);
    }

    const scanResult: LogicArbScanResult = {
      pairsTotal,
      pairsScanned,
      scannedAt: Date.now(),
    };
    this.emit('scanned', scanResult);
  }
}
