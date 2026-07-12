/**
 * Risk Manager — enforces position size and daily loss limits across
 * all modules. All order execution should pass through checkOrder().
 */

import { logger } from './logger.js';

export interface OrderRequest {
  module: string;
  conditionId: string;
  side: 'YES' | 'NO';
  sizeUsdc: number;
}

export interface RiskConfig {
  maxPositionSizeUsdc: number;
  dailyLossLimitUsdc: number;
}

export class RiskManager {
  private config: RiskConfig;
  private dailyPnl: number = 0;
  private dayKey: string;

  constructor(config: RiskConfig) {
    this.config = config;
    this.dayKey = new Date().toISOString().slice(0, 10);
  }

  private resetIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dayKey) {
      this.dailyPnl = 0;
      this.dayKey = today;
      logger.info('[RiskManager] New trading day — daily P&L reset.');
    }
  }

  /**
   * Returns true if the order passes all risk checks.
   */
  checkOrder(order: OrderRequest): boolean {
    this.resetIfNewDay();

    if (order.sizeUsdc > this.config.maxPositionSizeUsdc) {
      logger.warn(
        `[RiskManager] Order rejected: size ${order.sizeUsdc} > max ${this.config.maxPositionSizeUsdc}`,
      );
      return false;
    }

    if (this.dailyPnl <= -this.config.dailyLossLimitUsdc) {
      logger.warn(
        `[RiskManager] Order rejected: daily loss limit hit (${this.dailyPnl} USDC).`,
      );
      return false;
    }

    return true;
  }

  recordPnl(pnl: number): void {
    this.resetIfNewDay();
    this.dailyPnl += pnl;
    logger.info(`[RiskManager] P&L update: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | Daily: ${this.dailyPnl.toFixed(2)}`);
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }
}
