/**
 * Centralised config loader for the Polymarket Sniper Suite.
 *
 * Call loadConfig() once at process start (after dotenv.config()).
 * Throws a descriptive error for any missing required variable.
 */

import { config as dotenvConfig } from 'dotenv';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  // Wallet
  privateKey: string;
  walletAddress: string;

  // Polymarket CLOB API
  polymarketApiKey: string;
  polymarketApiSecret: string;
  polymarketPassphrase: string;

  // Supabase
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;

  // API Football (API-Sports)
  apiFootballKey: string;

  // OddsPapi (sports odds feed; includes Polymarket as a native bookmaker slug)
  oddspapiKey: string;

  // Trading behaviour
  tradingMode: 'paper' | 'live';
  maxPositionSizeUsdc: number;
  maxPositionPercentage: number;   // % of capital per trade (fixed-fraction)
  positionSizePct: number;         // % of capital for dynamic position sizing (dip-arb)
  minPositionSizeUsdc: number;
  dailyLossLimitUsdc: number;
  minProfitThreshold: number;      // minimum edge (0–1) to enter a trade
  maxExposurePerMarketUsdc: number;
  maxGlobalExposureUsdc: number;
  cooldownMinutes: number;         // pause after N consecutive losses

  // Module toggles
  enableLatencySniper: boolean;
  enableResolutionArb: boolean;
  enableCrossMarketArb: boolean;
  enableMarketMaking: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[Config] Required environment variable "${key}" is not set.`);
  }
  return value;
}

function optionalStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`[Config] "${key}" must be a number, got: "${raw}"`);
  }
  return n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`[Config] "${key}" must be "true" or "false", got: "${raw}"`);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _config: Config | null = null;

/**
 * Loads and validates all environment variables.
 * Result is cached — subsequent calls return the same object.
 *
 * @example
 *   import { loadConfig } from '../shared/config.js';
 *   const config = loadConfig();
 */
export function loadConfig(): Config {
  if (_config) return _config;

  // Load .env file if present (no-op if already loaded or running on Railway).
  dotenvConfig();

  const tradingModeRaw = optionalStr('TRADING_MODE', 'paper');
  if (tradingModeRaw !== 'paper' && tradingModeRaw !== 'live') {
    throw new Error(
      `[Config] TRADING_MODE must be "paper" or "live", got: "${tradingModeRaw}"`,
    );
  }

  _config = {
    // Wallet — required
    privateKey: requireEnv('PRIVATE_KEY'),
    walletAddress: requireEnv('WALLET_ADDRESS'),

    // Polymarket — required
    polymarketApiKey: requireEnv('POLYMARKET_API_KEY'),
    polymarketApiSecret: requireEnv('POLYMARKET_API_SECRET'),
    polymarketPassphrase: requireEnv('POLYMARKET_PASSPHRASE'),

    // Supabase — required
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseAnonKey: requireEnv('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),

    // API Football — required when latency sniper is enabled
    apiFootballKey: optionalStr('API_FOOTBALL_KEY', ''),

    // OddsPapi — required when sportsbook-arb module is enabled
    oddspapiKey: optionalStr('ODDSPAPI_KEY', ''),

    // Trading
    tradingMode: tradingModeRaw,
    maxPositionSizeUsdc: optionalNum('MAX_POSITION_SIZE_USDC', 100),
    maxPositionPercentage: optionalNum('MAX_POSITION_PERCENTAGE', 2),
    positionSizePct: optionalNum('POSITION_SIZE_PCT', 2),
    minPositionSizeUsdc: optionalNum('MIN_POSITION_SIZE_USDC', 10),
    dailyLossLimitUsdc: optionalNum('DAILY_LOSS_LIMIT_USDC', 50),
    minProfitThreshold: optionalNum('MIN_PROFIT_THRESHOLD', 0.05),
    maxExposurePerMarketUsdc: optionalNum('MAX_EXPOSURE_PER_MARKET_USDC', 500),
    maxGlobalExposureUsdc: optionalNum('MAX_GLOBAL_EXPOSURE_USDC', 2000),
    cooldownMinutes: optionalNum('COOLDOWN_MINUTES', 30),

    // Module toggles
    enableLatencySniper: optionalBool('ENABLE_LATENCY_SNIPER', true),
    enableResolutionArb: optionalBool('ENABLE_RESOLUTION_ARB', true),
    enableCrossMarketArb: optionalBool('ENABLE_CROSS_MARKET_ARB', false),
    enableMarketMaking: optionalBool('ENABLE_MARKET_MAKING', false),
  };

  return _config;
}
