/**
 * Latency-sniper module configuration.
 *
 * Derived from the top-level Config; call loadLatencySniperConfig(mainConfig)
 * after loadConfig() to get a fully validated module config.
 */

import type { Config } from '../shared/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LatencySniperConfig {
  enabled: boolean;
  apiFootballKey: string;
  pollIntervalMs: number;         // default: 10 000 ms
  minProfitThreshold: number;     // minimum edge to enter a trade (0–1)
  maxPositionSizeUsdc: number;
  tradingMode: 'paper' | 'live';

  // Event filtering
  targetLeagues: string[];        // only monitor these leagues
  targetEventTypes: string[];     // 'Goal' | 'Card' | 'Var' | 'Substitution'

  // Rate-limiting
  maxApiCallsPerMinute: number;   // default: 8 (safe under 10/min free-tier cap)

  // Order book quality gate
  minOrderBookDepthUsdc: number;  // skip markets thinner than this
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_LEAGUES = [
  'Premier League',
  'La Liga',
  'Serie A',
  'Bundesliga',
  'Ligue 1',
  'UEFA Champions League',
  'UEFA Europa League',
];

const DEFAULT_TARGET_EVENT_TYPES = ['Goal', 'Card'];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @example
 *   const config = loadConfig();
 *   const sniperConfig = loadLatencySniperConfig(config);
 */
export function loadLatencySniperConfig(main: Config): LatencySniperConfig {
  if (main.enableLatencySniper && !main.apiFootballKey) {
    throw new Error(
      '[LatencySniperConfig] API_FOOTBALL_KEY is required when ENABLE_LATENCY_SNIPER=true',
    );
  }

  // Allow env overrides for league / event-type lists as CSV strings
  const targetLeagues = process.env.TARGET_LEAGUES
    ? process.env.TARGET_LEAGUES.split(',').map((s) => s.trim())
    : DEFAULT_TARGET_LEAGUES;

  const targetEventTypes = process.env.TARGET_EVENT_TYPES
    ? process.env.TARGET_EVENT_TYPES.split(',').map((s) => s.trim())
    : DEFAULT_TARGET_EVENT_TYPES;

  const pollIntervalMs = process.env.POLL_INTERVAL_MS
    ? Number(process.env.POLL_INTERVAL_MS)
    : 10_000;

  const maxApiCallsPerMinute = process.env.MAX_API_CALLS_PER_MINUTE
    ? Number(process.env.MAX_API_CALLS_PER_MINUTE)
    : 8;

  return {
    enabled: main.enableLatencySniper,
    apiFootballKey: main.apiFootballKey,
    pollIntervalMs,
    minProfitThreshold: main.minProfitThreshold,
    maxPositionSizeUsdc: main.maxPositionSizeUsdc,
    tradingMode: main.tradingMode,
    targetLeagues,
    targetEventTypes,
    maxApiCallsPerMinute,
    minOrderBookDepthUsdc: 500,
  };
}
