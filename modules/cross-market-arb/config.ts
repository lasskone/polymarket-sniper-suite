import dotenv from 'dotenv';
dotenv.config();

export const crossMarketArbConfig = {
  enabled: process.env.ENABLE_CROSS_MARKET_ARB === 'true',
  tradingMode: (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'live',
  maxPositionSizeUsdc: Number(process.env.MAX_POSITION_SIZE_USDC ?? 100),
  minSpreadPct: Number(process.env.MIN_PROFIT_THRESHOLD ?? 0.05),
  // Kalshi API base URL
  kalshiApiBase: 'https://trading-api.kalshi.com/trade-api/v2',
  // Poll interval for price feed diffing (ms)
  pollIntervalMs: 10_000,
};
