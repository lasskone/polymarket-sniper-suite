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
import type { GammaApiClient, GammaMarket } from '../clients/gamma-api.js';
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

/** Default signal cooldown: 30 minutes. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Number of consecutive scan cycles in which a market returns null before the
 * pair is auto-deactivated.  5 cycles × 60 s/cycle = 5 minutes of null data.
 */
const DEFAULT_DEAD_PAIR_NULL_THRESHOLD = 5;

const DEFAULT_CONFIG: LogicArbConfig = {
  shares:               10,
  minNetProfitUSD:      0.05,
  scanIntervalMs:       60_000,
  feeRate:              LOGIC_ARB_FEE_RATE,
  cooldownMs:           DEFAULT_COOLDOWN_MS,
  deadPairNullThreshold: DEFAULT_DEAD_PAIR_NULL_THRESHOLD,
};

// ============= Market validity helper =============

/**
 * Returns true when a Gamma API market response should be treated as a live,
 * tradeable market for the given conditionId.
 *
 * Two failure modes require this guard:
 *
 * 1. **conditionId mismatch** — Gamma's `condition_id` query param is
 *    unreliable.  When the requested conditionId is no longer indexed (e.g. the
 *    market resolved and was removed from the active index), the API silently
 *    ignores the filter and returns a default/random active market.  We detect
 *    this by comparing the returned `conditionId` against what we requested.
 *
 * 2. **Market closed** — `closed: true` in the Gamma response means the market
 *    has resolved and is no longer tradeable.  Even if the conditionId matches,
 *    a closed market cannot be traded and should be treated as absent.
 *
 * @param market             - The value returned by getMarketByConditionId().
 * @param expectedConditionId - The conditionId that was requested.
 */
function isValidMarket(market: GammaMarket | null, expectedConditionId: string): boolean {
  if (!market) return false;
  if (market.conditionId !== expectedConditionId) return false;   // Gamma returned wrong market
  if (market.closed) return false;                                 // market has resolved
  return true;
}

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
   * Signal cooldown tracker: pairId → timestamp of last emitted signal.
   * Prevents the same still-valid opportunity from flooding paper_trades on
   * every 60-second scan cycle.
   */
  private signalCooldown = new Map<string, number>();

  /**
   * Consecutive-null counter: pairId → number of consecutive scan cycles in
   * which getMarketByConditionId() returned null for at least one side.
   * Reset to 0 when both markets return valid data. Used for dead-pair detection.
   */
  private consecutiveNullCount = new Map<string, number>();

  /** Structured JSON log — visible in Railway log stream without a WebSocket client. */
  private slog(level: string, message: string, data?: Record<string, unknown>): void {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      module: 'logic-arb',
      message,
    };
    if (data) entry.data = data;
    console.log(JSON.stringify(entry));
  }

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
    this.slog('INFO', 'LogicArb scanner started');
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
    this.signalCooldown.clear();
    this.consecutiveNullCount.clear();
    this.slog('INFO', 'LogicArb scanner stopped');
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
      // PGRST205 = PostgREST schema cache miss — the table does not exist yet.
      // Treat as an empty scan rather than a crash so the service keeps polling
      // while the migration is pending. Emit 'warn' (not 'error') so runWithRestart
      // doesn't restart in a tight loop.
      const isTableMissing =
        (error as { code?: string }).code === 'PGRST205' ||
        error.message.includes('schema cache');

      if (isTableMissing) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          module: 'logic-arb',
          message: 'correlated_market_pairs table not found — migration pending; scan skipped',
        }));
        // Emit a graceful empty scan result so the 'scanned' listener still fires.
        this.emit('scanned', { pairsTotal: 0, pairsScanned: 0, scannedAt: Date.now() });
        return;
      }

      throw new Error(`LogicArbService: failed to fetch pairs: ${error.message}`);
    }

    const pairsTotal = pairs?.length ?? 0;
    let pairsScanned = 0;

    for (const pair of (pairs ?? []) as CorrelatedPairRow[]) {
      // Fetch prices for both markets in parallel.
      const [rawA, rawB] = await Promise.all([
        this.gammaApi.getMarketByConditionId(pair.market_a_condition_id),
        this.gammaApi.getMarketByConditionId(pair.market_b_condition_id),
      ]);

      // ── Market validity check ──────────────────────────────────────────────
      // Gamma's `condition_id` query param is unreliable: the API silently ignores
      // it and returns a default result when the conditionId is not indexed.  We
      // must therefore verify the conditionId of the returned market matches what
      // we requested; a mismatch means the underlying market is no longer accessible.
      // We also treat a closed market (resolved, no longer tradeable) as absent.
      const marketA = isValidMarket(rawA, pair.market_a_condition_id) ? rawA as GammaMarket : null;
      const marketB = isValidMarket(rawB, pair.market_b_condition_id) ? rawB as GammaMarket : null;

      // ── Dead-pair detection ────────────────────────────────────────────────
      // If either market is absent (null return, conditionId mismatch, or closed),
      // increment the consecutive-absent counter.  After deadPairNullThreshold
      // consecutive absent cycles, mark the pair inactive in the DB.
      if (!marketA || !marketB) {
        const nullCount = (this.consecutiveNullCount.get(pair.id) ?? 0) + 1;
        this.consecutiveNullCount.set(pair.id, nullCount);

        if (nullCount >= this.cfg.deadPairNullThreshold) {
          this.slog('WARN', `LogicArb dead-pair detected — deactivating "${pair.market_a_slug}" / "${pair.market_b_slug}"`, {
            pairId:        pair.id,
            nullCount,
            absentA:       !marketA,
            absentB:       !marketB,
            rawACondId:    rawA?.conditionId ?? null,
            rawBCondId:    rawB?.conditionId ?? null,
            rawAClosed:    rawA?.closed ?? null,
            rawBClosed:    rawB?.closed ?? null,
          });
          // Update the DB row so it is excluded from future scans.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: updateError } = await (this.supabase as any)
            .from('correlated_market_pairs')
            .update({ active: false })
            .eq('id', pair.id);
          if (updateError) {
            this.slog('WARN', `LogicArb dead-pair update failed for ${pair.id}: ${updateError.message}`);
          } else {
            // Remove from in-memory trackers — pair won't appear in future scans.
            this.consecutiveNullCount.delete(pair.id);
            this.signalCooldown.delete(pair.id);
          }
        } else {
          this.slog('DEBUG', `LogicArb market absent for pair "${pair.market_a_slug}" / "${pair.market_b_slug}" (${nullCount}/${this.cfg.deadPairNullThreshold} consecutive absent cycles)`);
        }
        continue;
      }

      // Both markets returned valid, matching, open data — reset the absent counter.
      this.consecutiveNullCount.set(pair.id, 0);

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

      // ── Signal cooldown ───────────────────────────────────────────────────
      // Suppress re-emission for the same pair until cooldownMs has elapsed.
      const lastSignaledAt = this.signalCooldown.get(pair.id) ?? 0;
      const now = Date.now();
      if (now - lastSignaledAt < this.cfg.cooldownMs) {
        this.slog('DEBUG', `LogicArb ${pair.relationship} "${pair.market_a_slug}" / "${pair.market_b_slug}" suppressed — cooldown active (${Math.round((this.cfg.cooldownMs - (now - lastSignaledAt)) / 60_000)}m remaining)`);
        continue;
      }

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

      this.signalCooldown.set(pair.id, now);
      this.slog('SIGNAL', `LogicArb ${pair.relationship} "${pair.market_a_slug}" / "${pair.market_b_slug}" dev=${signal.deviation.toFixed(4)} net=$${net.toFixed(4)}`);
      this.emit('signal', signal);
    }

    const scanResult: LogicArbScanResult = {
      pairsTotal,
      pairsScanned,
      scannedAt: Date.now(),
    };
    this.slog('INFO', `LogicArb scanned ${pairsScanned}/${pairsTotal} pairs`);
    this.emit('scanned', scanResult);
  }
}
