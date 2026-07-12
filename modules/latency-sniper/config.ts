import dotenv from 'dotenv';
dotenv.config();

export const latencySniperConfig = {
  enabled: process.env.ENABLE_LATENCY_SNIPER === 'true',
  apiFootballKey: process.env.API_FOOTBALL_KEY ?? '',
  maxPositionSizeUsdc: Number(process.env.MAX_POSITION_SIZE_USDC ?? 100),
  minProfitThreshold: Number(process.env.MIN_PROFIT_THRESHOLD ?? 0.05),
  tradingMode: (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'live',
  // Polling interval for live match events (ms)
  pollIntervalMs: 5_000,
  // Markets to skip if order book is too thin
  minOrderBookDepthUsdc: 500,
};
