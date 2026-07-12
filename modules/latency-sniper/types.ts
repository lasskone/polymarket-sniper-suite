/**
 * Shared types for the latency-sniper module.
 *
 * Defined here to avoid circular imports between market-matcher,
 * pricing, trade-executor, and index.
 */

import type { NewEvent }         from './event-detector.js';
import type { PolymarketMarket } from './market-matcher.js';
import type { PriceEstimate }    from './utils/pricing.js';

// ---------------------------------------------------------------------------
// Opportunity — a priced trade candidate, ready for risk check + execution
// ---------------------------------------------------------------------------

export interface Opportunity {
  /** The football event that triggered this opportunity */
  event: NewEvent;
  /** The matched Polymarket market */
  market: PolymarketMarket;
  /** Pricing model output */
  priceEstimate: PriceEstimate;
  /** Which outcome to trade */
  side: 'YES' | 'NO';
  /** Requested trade size in USDC (before risk adjustment) */
  sizeUsdc: number;
}

// ---------------------------------------------------------------------------
// TradeResult — returned by TradeExecutor after attempting an order
// ---------------------------------------------------------------------------

export interface TradeResult {
  success: boolean;
  orderId?: string;
  filledSize?: number;    // tokens filled
  avgPrice?: number;      // average fill price
  amountUsdc?: number;    // USDC actually spent
  error?: string;
  executedAt: number;     // Date.now()
  paper: boolean;         // true = paper trade, false = live
}

// ---------------------------------------------------------------------------
// OrderStatus — mirrors CLOB open-order status values
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'OPEN'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLED'
  | 'FAILED'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// TradeRecord — what gets persisted to Supabase trades table
// ---------------------------------------------------------------------------

export interface TradeRecord {
  module: string;
  marketId: string;
  marketSlug: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;         // token quantity
  amountUsdc: number;
  orderId: string;
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  expectedProfit: number;
  metadata: Record<string, unknown>;
}
