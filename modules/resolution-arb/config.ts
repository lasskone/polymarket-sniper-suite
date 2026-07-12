import dotenv from 'dotenv';
dotenv.config();

export const resolutionArbConfig = {
  enabled: process.env.ENABLE_RESOLUTION_ARB === 'true',
  tradingMode: (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'live',
  maxPositionSizeUsdc: Number(process.env.MAX_POSITION_SIZE_USDC ?? 100),
  minProfitThreshold: Number(process.env.MIN_PROFIT_THRESHOLD ?? 0.05),
  // How long before resolution we're willing to enter (hours)
  maxHoursToResolution: 72,
  // Minimum discount to fair value (1.0) required to enter
  minDiscountToFairValue: 0.04,
};
