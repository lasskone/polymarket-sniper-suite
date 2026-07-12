/**
 * TradeExecutor — places FOK market orders on the Polymarket CLOB.
 *
 * Initialization (called once at startup):
 *   1. Create ethers Wallet from PRIVATE_KEY
 *   2. Create ClobClient (L1 auth only — signer, no creds yet)
 *   3. Derive API credentials via createOrDeriveApiKey()
 *   4. Re-create ClobClient with both signer + creds (L2 auth)
 *
 * Order flow:
 *   executeTrade(opportunity)
 *     → placeOrder(market, side, sizeUsdc, price)
 *         → getMarket(conditionId)    [resolves tokenID]
 *         → createAndPostMarketOrder  [FOK]
 *         → waitForFill               [polls up to 30s]
 *     → return TradeResult
 *
 * Paper mode:
 *   When tradingMode === 'paper', the executor logs every action but
 *   never touches the CLOB. All TradeResults have paper: true.
 */

import { Wallet } from 'ethers';
import {
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
} from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';

import { createLogger }          from '../shared/logger.js';
import type { LatencySniperConfig } from './config.js';
import type { Opportunity, TradeResult, OrderStatus } from './types.js';

const log = createLogger('trade-executor');

const CLOB_HOST  = 'https://clob.polymarket.com';
const CHAIN_ID   = 137;   // Polygon mainnet

// How long to poll for a fill before giving up
const DEFAULT_FILL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS        = 2_000;

// ---------------------------------------------------------------------------
// TradeExecutor
// ---------------------------------------------------------------------------

export class TradeExecutor {
  private client: ClobClient | null = null;
  private creds: ApiKeyCreds | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;

  constructor(private readonly config: LatencySniperConfig & {
    privateKey: string;
    walletAddress: string;
  }) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Derives CLOB API credentials and builds an authenticated client.
   * Must be called once before any order placement.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.tradingMode === 'paper') {
      log.info('Paper mode — skipping CLOB initialization');
      this.initialized = true;
      return;
    }

    log.info('Initializing CLOB client', {
      walletAddress: this.config.walletAddress,
      chainId: CHAIN_ID,
    });

    this.wallet = new Wallet(this.config.privateKey);

    // L1-only client — used just to derive API keys
    const l1Client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      this.wallet,
      undefined,                       // no creds yet
      SignatureType.EOA,               // standard EOA signing
      this.config.walletAddress,
    );

    log.info('Deriving CLOB API credentials…');
    this.creds = await l1Client.createOrDeriveApiKey();
    log.info('API credentials derived', { key: this.creds.key.slice(0, 8) + '…' });

    // L2 client — signer + creds for order placement
    this.client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      this.wallet,
      this.creds,
      SignatureType.EOA,
      this.config.walletAddress,
    );

    this.initialized = true;
    log.info('CLOB client initialized');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Main entry point. Validates the opportunity then delegates to placeOrder().
   */
  async executeTrade(opp: Opportunity): Promise<TradeResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { market, side, sizeUsdc, priceEstimate } = opp;

    log.info('Executing trade', {
      marketId:  market.id,
      question:  market.question,
      side,
      sizeUsdc,
      price:     priceEstimate.currentPrice,
      edge:      priceEstimate.edge,
      confidence: priceEstimate.confidence,
    });

    // Paper mode — simulate without hitting the CLOB
    if (this.config.tradingMode === 'paper') {
      return this.paperTrade(opp);
    }

    return this.placeOrder(market, side, sizeUsdc, priceEstimate.currentPrice);
  }

  /**
   * Places a FOK market order on the CLOB.
   *
   * @param market    Target Polymarket market (needs conditionId)
   * @param side      'YES' or 'NO' outcome to buy
   * @param sizeUsdc  USDC amount to spend
   * @param price     Limit price for the order (0–1)
   */
  async placeOrder(
    market: import('./market-matcher.js').PolymarketMarket,
    side: 'YES' | 'NO',
    sizeUsdc: number,
    price: number,
  ): Promise<TradeResult> {
    if (!this.client || !this.initialized) {
      return this.errorResult('CLOB client not initialized — call initialize() first');
    }

    try {
      // ── Resolve token ID ────────────────────────────────────────────────────
      const clobMarket = await this.client.getMarket(market.conditionId) as {
        tokens?: Array<{ token_id: string; outcome: string }>;
      };

      if (!clobMarket?.tokens || clobMarket.tokens.length < 2) {
        return this.errorResult(
          `Could not resolve tokens for conditionId ${market.conditionId}`,
        );
      }

      // Polymarket conventions: tokens[0] = YES, tokens[1] = NO
      const tokenIdx = side === 'YES' ? 0 : 1;
      const tokenId  = clobMarket.tokens[tokenIdx].token_id;

      log.debug('Resolved token ID', {
        conditionId: market.conditionId,
        side,
        tokenId: tokenId.slice(0, 20) + '…',
      });

      // ── Build FOK market order ──────────────────────────────────────────────
      // For BUY + FOK: amount = USDC to spend
      // Price must be rounded to the market's tick size (default 0.01)
      const roundedPrice = Math.round(price * 100) / 100;

      const userMarketOrder = {
        tokenID: tokenId,
        price:   roundedPrice,
        amount:  sizeUsdc,         // USDC amount for BUY orders
        side:    Side.BUY,
      };

      log.info('Placing FOK market order', {
        tokenId: tokenId.slice(0, 20) + '…',
        price:   roundedPrice,
        amount:  sizeUsdc,
        side:    'BUY',
      });

      // ── Submit ──────────────────────────────────────────────────────────────
      const response = await this.client.createAndPostMarketOrder(
        userMarketOrder,
        {},
        OrderType.FOK,
      ) as { orderID?: string; status?: string; [k: string]: unknown };

      const orderId = response?.orderID ?? '';

      if (!orderId) {
        return this.errorResult('Order placed but no orderID returned', response);
      }

      log.info('Order submitted', { orderId, response });

      // ── Wait for fill ───────────────────────────────────────────────────────
      const finalStatus = await this.waitForFill(orderId, DEFAULT_FILL_TIMEOUT_MS);

      if (finalStatus === 'FILLED') {
        const openOrder = await this.client.getOrder(orderId);
        const filledSize  = parseFloat(openOrder.size_matched ?? '0');
        const avgPrice    = parseFloat(openOrder.price ?? String(roundedPrice));
        const amountUsdc  = filledSize * avgPrice;

        log.info('Order filled', { orderId, filledSize, avgPrice, amountUsdc });

        return {
          success:     true,
          orderId,
          filledSize,
          avgPrice,
          amountUsdc,
          executedAt:  Date.now(),
          paper:       false,
        };
      }

      if (finalStatus === 'PARTIALLY_FILLED') {
        const openOrder  = await this.client.getOrder(orderId);
        const filledSize = parseFloat(openOrder.size_matched ?? '0');

        log.warn('Order partially filled (FOK should be all-or-nothing)', {
          orderId, filledSize, status: finalStatus,
        });

        return {
          success:    filledSize > 0,
          orderId,
          filledSize,
          avgPrice:   parseFloat(openOrder.price ?? String(roundedPrice)),
          amountUsdc: filledSize * parseFloat(openOrder.price ?? String(roundedPrice)),
          executedAt: Date.now(),
          paper:      false,
        };
      }

      // CANCELLED / FAILED / UNKNOWN — FOK couldn't fill
      log.warn('FOK order not filled', { orderId, status: finalStatus });
      return {
        success:    false,
        orderId,
        error:      `Order ${finalStatus} — FOK could not fill at ${roundedPrice}`,
        executedAt: Date.now(),
        paper:      false,
      };

    } catch (err) {
      return this.errorResult(String(err));
    }
  }

  /**
   * Returns the current status of a CLOB order.
   */
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    if (!this.client) return 'UNKNOWN';

    try {
      const order = await this.client.getOrder(orderId);
      return this.mapStatus(order.status);
    } catch (err) {
      log.error('getOrderStatus failed', { orderId, error: String(err) });
      return 'UNKNOWN';
    }
  }

  /**
   * Polls the CLOB until the order reaches a terminal state or times out.
   */
  async waitForFill(
    orderId: string,
    timeoutMs: number = DEFAULT_FILL_TIMEOUT_MS,
  ): Promise<OrderStatus> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getOrderStatus(orderId);

      if (status !== 'OPEN') {
        log.debug('waitForFill: terminal status reached', { orderId, status });
        return status;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    log.warn('waitForFill: timed out', { orderId, timeoutMs });
    return 'UNKNOWN';
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private paperTrade(opp: Opportunity): TradeResult {
    const tokenAmount = opp.sizeUsdc / opp.priceEstimate.currentPrice;

    log.info('PAPER TRADE — would place order', {
      marketId:   opp.market.id,
      question:   opp.market.question,
      side:       opp.side,
      sizeUsdc:   opp.sizeUsdc,
      price:      opp.priceEstimate.currentPrice,
      tokenAmount: tokenAmount.toFixed(4),
      edge:       opp.priceEstimate.edge,
      confidence: opp.priceEstimate.confidence,
      reasoning:  opp.priceEstimate.reasoning,
    });

    return {
      success:    true,
      orderId:    `PAPER-${Date.now()}`,
      filledSize: tokenAmount,
      avgPrice:   opp.priceEstimate.currentPrice,
      amountUsdc: opp.sizeUsdc,
      executedAt: Date.now(),
      paper:      true,
    };
  }

  private errorResult(
    error: string,
    context?: unknown,
  ): TradeResult {
    log.error('Trade execution error', { error, context });
    return { success: false, error, executedAt: Date.now(), paper: false };
  }

  private mapStatus(raw: string | undefined): OrderStatus {
    switch ((raw ?? '').toUpperCase()) {
      case 'LIVE':
      case 'OPEN':             return 'OPEN';
      case 'MATCHED':
      case 'FILLED':           return 'FILLED';
      case 'PARTIALLY_FILLED':
      case 'PARTIAL':          return 'PARTIALLY_FILLED';
      case 'CANCELED':
      case 'CANCELLED':        return 'CANCELLED';
      case 'ERROR':
      case 'FAILED':           return 'FAILED';
      default:                 return 'UNKNOWN';
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTradeExecutor(
  cfg: LatencySniperConfig & { privateKey: string; walletAddress: string },
): TradeExecutor {
  return new TradeExecutor(cfg);
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
