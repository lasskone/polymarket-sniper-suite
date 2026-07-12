/**
 * RiskManager — gates every order through a comprehensive set of checks
 * before it reaches the CLOB. Backed by Supabase for persistence.
 *
 * Checks (in order):
 *   1. Circuit breaker (daily loss limit hit today)
 *   2. Cooldown (N consecutive losing trades)
 *   3. Global exposure ceiling
 *   4. Per-market exposure ceiling
 *   5. Position size floor / ceiling → adjusts size if needed
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';
import { createLogger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RiskConfig {
  maxPositionSizeUsdc: number;
  maxPositionPercentage: number;   // % of capital — informational for now
  minPositionSizeUsdc: number;
  dailyLossLimitUsdc: number;
  maxExposurePerMarketUsdc: number;
  maxGlobalExposureUsdc: number;
  cooldownMinutes: number;
  consecutiveLossesBeforeCooldown?: number;  // default 3
}

export interface OrderCheckResult {
  allowed: boolean;
  reason: string;
  adjustedSize: number;  // may be smaller than requested; 0 when blocked
}

// Internal cache refreshed every 5 min
interface DailyCache {
  date: string;                  // YYYY-MM-DD
  dailyPnlUsdc: number;
  circuitBreakerTriggered: boolean;
  circuitBreakerReason: string | null;
  lastRefreshedAt: number;       // Date.now()
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class RiskManager {
  private readonly log = createLogger('risk-manager');
  private cache: DailyCache | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min
  private consecutiveLosses = 0;
  private cooldownUntil: Date | null = null;
  private readonly maxConsecutiveLosses: number;

  constructor(
    private readonly config: RiskConfig,
    private readonly supabase: SupabaseClient<Database>,
  ) {
    this.maxConsecutiveLosses = config.consecutiveLossesBeforeCooldown ?? 3;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Main gate. Call before every order.
   *
   * @example
   *   const check = await riskManager.checkOrder('latency-sniper', 'market123', 'BUY', 50, 0.50);
   *   if (!check.allowed) { logger.warn('Blocked', { reason: check.reason }); return; }
   *   // use check.adjustedSize
   */
  async checkOrder(
    module: string,
    marketId: string,
    side: 'BUY' | 'SELL',
    sizeUsdc: number,
    price: number,
  ): Promise<OrderCheckResult> {
    const block = (reason: string): OrderCheckResult => {
      this.log.warn('Order blocked', { module, marketId, side, sizeUsdc, reason });
      return { allowed: false, reason, adjustedSize: 0 };
    };

    // 1. Circuit breaker
    const daily = await this.getDailyCache();
    if (daily.circuitBreakerTriggered) {
      return block(`Circuit breaker active: ${daily.circuitBreakerReason ?? 'daily loss limit'}`);
    }

    // 2. Cooldown
    if (this.cooldownUntil && new Date() < this.cooldownUntil) {
      const remaining = Math.ceil((this.cooldownUntil.getTime() - Date.now()) / 60_000);
      return block(`Cooldown active — ${remaining} min remaining after ${this.maxConsecutiveLosses} consecutive losses`);
    }

    // 3. Daily loss limit
    if (daily.dailyPnlUsdc <= -this.config.dailyLossLimitUsdc) {
      await this.triggerCircuitBreaker(
        `Daily loss limit of ${this.config.dailyLossLimitUsdc} USDC reached`,
      );
      return block(`Daily loss limit of ${this.config.dailyLossLimitUsdc} USDC reached`);
    }

    // 4. Global exposure
    const globalExposure = await this.getGlobalExposure();
    if (globalExposure + sizeUsdc > this.config.maxGlobalExposureUsdc) {
      return block(
        `Global exposure would reach ${(globalExposure + sizeUsdc).toFixed(2)} USDC (max ${this.config.maxGlobalExposureUsdc})`,
      );
    }

    // 5. Per-market exposure
    const marketExposure = await this.getMarketExposure(marketId);
    if (marketExposure + sizeUsdc > this.config.maxExposurePerMarketUsdc) {
      return block(
        `Market exposure would reach ${(marketExposure + sizeUsdc).toFixed(2)} USDC (max ${this.config.maxExposurePerMarketUsdc})`,
      );
    }

    // 6. Position size: clamp to [min, max]
    let adjustedSize = sizeUsdc;
    let sizeNote = '';

    if (adjustedSize < this.config.minPositionSizeUsdc) {
      return block(
        `Size ${adjustedSize} USDC is below minimum ${this.config.minPositionSizeUsdc} USDC`,
      );
    }

    if (adjustedSize > this.config.maxPositionSizeUsdc) {
      adjustedSize = this.config.maxPositionSizeUsdc;
      sizeNote = ` (reduced from ${sizeUsdc} to ${adjustedSize})`;
    }

    const reason = adjustedSize < sizeUsdc
      ? `Allowed with reduced size${sizeNote}`
      : 'All checks passed';

    this.log.debug('Order approved', {
      module, marketId, side,
      requestedSize: sizeUsdc,
      adjustedSize,
      price,
    });

    return { allowed: true, reason, adjustedSize };
  }

  /**
   * Call after a trade resolves with its P&L.
   * Updates the daily row in Supabase and manages consecutive-loss tracking.
   */
  async recordPnl(module: string, marketId: string, pnlUsdc: number): Promise<void> {
    const today = this.todayKey();

    // Update in-memory cache immediately
    if (this.cache?.date === today) {
      this.cache.dailyPnlUsdc += pnlUsdc;
    } else {
      this.cache = null;  // force refresh next check
    }

    // Consecutive loss tracking
    if (pnlUsdc < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        this.cooldownUntil = new Date(Date.now() + this.config.cooldownMinutes * 60_000);
        this.log.warn('Cooldown triggered', {
          consecutiveLosses: this.consecutiveLosses,
          cooldownUntil: this.cooldownUntil.toISOString(),
        });
      }
    } else {
      this.consecutiveLosses = 0;
    }

    this.log.info('P&L recorded', {
      module, marketId,
      pnlUsdc,
      dailyRunning: this.cache?.dailyPnlUsdc,
    });

    // Upsert Supabase risk_management row
    const { error } = await this.supabase
      .from('risk_management')
      .upsert(
        {
          date: today,
          daily_pnl_usdc: this.cache?.dailyPnlUsdc ?? pnlUsdc,
          last_trade_at: new Date().toISOString(),
        },
        { onConflict: 'date' },
      );

    if (error) {
      this.log.error('Failed to persist P&L to Supabase', { error: error.message });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async getDailyCache(): Promise<DailyCache> {
    const today = this.todayKey();
    const now = Date.now();

    if (
      this.cache &&
      this.cache.date === today &&
      now - this.cache.lastRefreshedAt < this.CACHE_TTL_MS
    ) {
      return this.cache;
    }

    // Fetch from Supabase
    const { data, error } = await this.supabase
      .from('risk_management')
      .select('daily_pnl_usdc, circuit_breaker_triggered, circuit_breaker_reason')
      .eq('date', today)
      .maybeSingle();

    if (error) {
      this.log.error('Failed to fetch daily risk state', { error: error.message });
    }

    this.cache = {
      date: today,
      dailyPnlUsdc: data?.daily_pnl_usdc ?? 0,
      circuitBreakerTriggered: data?.circuit_breaker_triggered ?? false,
      circuitBreakerReason: data?.circuit_breaker_reason ?? null,
      lastRefreshedAt: now,
    };

    return this.cache;
  }

  private async triggerCircuitBreaker(reason: string): Promise<void> {
    if (this.cache) {
      this.cache.circuitBreakerTriggered = true;
      this.cache.circuitBreakerReason = reason;
    }

    this.log.warn('Circuit breaker triggered', { reason });

    const { error } = await this.supabase
      .from('risk_management')
      .upsert(
        {
          date: this.todayKey(),
          circuit_breaker_triggered: true,
          circuit_breaker_reason: reason,
        },
        { onConflict: 'date' },
      );

    if (error) {
      this.log.error('Failed to persist circuit breaker state', { error: error.message });
    }
  }

  private async getGlobalExposure(): Promise<number> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('amount_usdc')
      .in('status', ['pending', 'filled'])
      .gte('created_at', `${this.todayKey()}T00:00:00.000Z`);

    if (error) {
      this.log.error('Failed to fetch global exposure', { error: error.message });
      return 0;
    }

    return (data ?? []).reduce((sum, row) => sum + (row.amount_usdc ?? 0), 0);
  }

  private async getMarketExposure(marketId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('amount_usdc')
      .eq('market_id', marketId)
      .in('status', ['pending', 'filled'])
      .gte('created_at', `${this.todayKey()}T00:00:00.000Z`);

    if (error) {
      this.log.error('Failed to fetch market exposure', { error: error.message, marketId });
      return 0;
    }

    return (data ?? []).reduce((sum, row) => sum + (row.amount_usdc ?? 0), 0);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @example
 *   const riskManager = createRiskManager(config, supabaseClient);
 */
export function createRiskManager(
  config: RiskConfig,
  supabaseClient: SupabaseClient<Database>,
): RiskManager {
  return new RiskManager(config, supabaseClient);
}
