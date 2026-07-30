/**
 * Logic-Arb Live Execution Engine
 *
 * Executes a two-leg logic-arbitrage trade with:
 *   - Pre-flight balance + risk checks
 *   - Price-staleness guard (re-fetch at execution time)
 *   - CLOB order book depth heuristic for leg sequencing
 *   - Fill-confirmation polling with timeout
 *   - Automatic leg-1 unwind if leg-2 fails
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../modules/shared/database.types.js';
import type { RiskManager } from '../../modules/shared/risk-manager.js';
import type { TradingService } from './trading-service.js';
import { MIN_ORDER_SIZE_SHARES } from './trading-service.js';
import type { LogicArbSignal } from './logic-arb-types.js';
import { createLogger } from '../../modules/shared/logger.js';
import { dashboardEmitter } from '../dashboard/state-emitter.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CLOB_BASE = 'https://clob.polymarket.com';
const MODULE    = 'logic-arb';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutorDeps {
  tradingService: TradingService;
  riskManager:    RiskManager;
  supabase:       SupabaseClient<Database>;
}

export interface ExecutorConfig {
  /**
   * Maximum allowed price drift from signal's detected price before aborting.
   * Expressed in basis points (1 bps = 0.01%). Default: 50 bps (0.5%).
   */
  maxSlippageBps:      number;
  /**
   * Max time (ms) to wait for a leg order to fill before treating it as a
   * timeout and either aborting (leg 1) or unwinding (leg 2).
   * Default: 10_000 (10 seconds).
   */
  fillTimeoutMs:       number;
  /**
   * Interval (ms) between fill-confirmation polls.
   * Default: 500 ms.
   */
  pollIntervalMs?:     number;
  /**
   * Maximum position size in USDC — passed explicitly from RiskConfig
   * rather than reading from the private RiskManager.config field.
   */
  maxPositionSizeUsdc: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  maxSlippageBps:      50,
  fillTimeoutMs:       10_000,
  pollIntervalMs:      500,
  maxPositionSizeUsdc: 100,
};

export type ExecutionAbortReason =
  | 'insufficient-balance'
  | 'risk-gate-leg-a'
  | 'risk-gate-leg-b'
  | 'price-stale'
  | 'token-ids-unavailable'
  | 'leg1-order-failed'
  | 'leg1-timeout';

export type ExecutionResult =
  | { status: 'aborted';  reason: ExecutionAbortReason; detail: string }
  | { status: 'unwind';   leg1FillPrice: number; leg1Shares: number; unwindSuccess: boolean; detail: string }
  | { status: 'success';  leg1FillPrice: number; leg2FillPrice: number; shares: number; realizedPnl: number };

// ─── CLOB API helpers (public, no auth required) ─────────────────────────────

interface ClobTokenInfo {
  token_id: string;
  outcome:  string;   // "Yes" or "No"
}

interface ClobMarketInfo {
  tokens:         ClobTokenInfo[];
  taker_base_fee: number;
}

/** Fetches token IDs from the CLOB for a given conditionId. Returns null on failure. */
async function fetchClobMarketInfo(conditionId: string): Promise<ClobMarketInfo | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/markets/${conditionId}`);
    if (!res.ok) return null;
    return (await res.json()) as ClobMarketInfo;
  } catch {
    return null;
  }
}

/** Returns total ask-side liquidity within `maxSlippageBps` of `targetPrice`. */
async function fetchAskDepthAtPrice(
  tokenId:        string,
  targetPrice:    number,
  maxSlippageBps: number,
): Promise<number> {
  try {
    const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    if (!res.ok) return 0;
    const book = await res.json() as { asks: Array<{ price: string; size: string }>; bids: unknown[] };
    const threshold = targetPrice * (1 + maxSlippageBps / 10_000);
    return book.asks
      .filter(a => parseFloat(a.price) <= threshold)
      .reduce((sum, a) => sum + parseFloat(a.size), 0);
  } catch {
    return 0;
  }
}

// ─── Position sizing ──────────────────────────────────────────────────────────

/**
 * Compute trade share count.
 *
 * shares = floor( min(targetUsdc, maxPositionSizeUsdc) / costPerSharePair )
 *
 * Where:
 *   targetUsdc       = currentBalance × sizingPct / 100
 *   costPerSharePair = legA.price + legB.price  (total USDC per 1-share pair)
 *
 * Capped to maxPositionSizeUsdc.
 * Returns 0 if the result is below MIN_ORDER_SIZE_SHARES.
 */
export function computeLogicArbShares(
  balanceUsdc:         number,
  sizingPct:           number,
  maxPositionSizeUsdc: number,
  legAPrice:           number,
  legBPrice:           number,
): number {
  const targetUsdc     = balanceUsdc * sizingPct / 100;
  const cappedUsdc     = Math.min(targetUsdc, maxPositionSizeUsdc);
  const costPerPair    = legAPrice + legBPrice;
  if (costPerPair <= 0) return 0;
  return Math.floor(cappedUsdc / costPerPair);
}

// ─── Fill-confirmation polling ────────────────────────────────────────────────

/**
 * Polls open orders until orderId is no longer present (= filled / cancelled)
 * or until timeoutMs elapses.
 *
 * Returns true if the order is gone (filled), false on timeout.
 */
async function waitForFill(
  tradingService: TradingService,
  orderId:        string,
  timeoutMs:      number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const openOrders = await tradingService.getOpenOrders();
      if (!openOrders.some(o => o.id === orderId)) {
        return true;  // order gone = filled (or cancelled by exchange)
      }
    } catch {
      // network error during poll — keep retrying until timeout
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;  // timed out
}

// ─── Unwind helper ───────────────────────────────────────────────────────────

interface UnwindOutcome {
  success:  boolean;   // true if any FOK attempt succeeded
  retried:  boolean;   // true if a second attempt was made
  orderId?: string;    // order ID of the successful attempt
}

/**
 * Attempt to unwind a leg-1 position via a market FOK SELL.
 * Retries once after 2 s on failure. If both attempts fail, triggers an
 * emergency risk-manager circuit-breaker pause and fires a dashboard ERROR alert.
 */
async function performUnwind(
  tradingService: TradingService,
  riskManager:    RiskManager,
  log:            ReturnType<typeof createLogger>,
  tokenId:        string,
  costUsdc:       number,
  filledShares:   number,
  fillPrice:      number,
  legLabel:       'A' | 'B',
  signal:         LogicArbSignal,
  triggerReason:  string,
): Promise<UnwindOutcome> {
  const sellParams = {
    tokenId,
    side:      'SELL'  as const,
    amount:    costUsdc,
    orderType: 'FOK'   as const,
  };

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  const attempt1 = await tradingService.createMarketOrder(sellParams);

  log.warn('FAILED-ARB-UNWIND', {
    pairId:        signal.pairId,
    marketASlug:   signal.marketASlug,
    marketBSlug:   signal.marketBSlug,
    relationship:  signal.relationship,
    legLabel,
    tokenId,
    fillPrice,
    filledShares,
    costUsdc,
    triggerReason,
    unwindSuccess: attempt1.success,
    retried:       false,
    unwindOrderId: attempt1.orderId,
    timestamp:     new Date().toISOString(),
  });

  if (attempt1.success) {
    return { success: true, retried: false, orderId: attempt1.orderId };
  }

  // ── Attempt 2 (retry after 2 s) ───────────────────────────────────────────
  await new Promise(resolve => setTimeout(resolve, 2_000));
  const attempt2 = await tradingService.createMarketOrder(sellParams);

  log.warn('FAILED-ARB-UNWIND retry', {
    pairId:        signal.pairId,
    unwindSuccess: attempt2.success,
    retried:       true,
    unwindOrderId: attempt2.orderId,
    attempt1Error: attempt1.errorMsg,
    attempt2Error: attempt2.errorMsg,
  });

  if (attempt2.success) {
    return { success: true, retried: true, orderId: attempt2.orderId };
  }

  // ── Double failure — position stuck ───────────────────────────────────────
  const emergencyReason =
    `Unwind double-failure: ${triggerReason} — ` +
    `leg-${legLabel} position of ${filledShares} shares ($${costUsdc.toFixed(2)}) is STUCK`;

  log.error('UNWIND DOUBLE-FAILURE — position STUCK, emergency pause triggered', {
    pairId:        signal.pairId,
    legLabel,
    tokenId,
    fillPrice,
    filledShares,
    costUsdc,
    triggerReason,
    attempt1Error: attempt1.errorMsg,
    attempt2Error: attempt2.errorMsg,
  });

  dashboardEmitter.log('ERROR',
    `[LOGIC-ARB] POSITION STUCK — unwind double-failure: ${signal.marketASlug} / ${signal.marketBSlug}`,
    {
      pairId:        signal.pairId,
      relationship:  signal.relationship,
      legLabel,
      tokenId,
      fillPrice,
      filledShares,
      costUsdc:      costUsdc.toFixed(2),
      triggerReason,
      attempt1Error: attempt1.errorMsg ?? 'unknown',
      attempt2Error: attempt2.errorMsg ?? 'unknown',
      action:        'EMERGENCY PAUSE triggered — all logic-arb trading halted until manually cleared',
    },
  );

  try {
    await riskManager.emergencyPause(MODULE, emergencyReason);
  } catch (pauseErr) {
    log.error('emergencyPause call failed', { error: String(pauseErr) });
  }

  return { success: false, retried: true };
}

// ─── Main execution function ──────────────────────────────────────────────────

/**
 * Execute a two-leg logic-arbitrage trade.
 *
 * **Pre-flight checks** (abort if any fail):
 *   1. Balance: both legs' total cost must be covered by wallet balance.
 *   2. Risk gate: riskManager.checkOrder() for both legs (Leg A then Leg B).
 *   3. Price staleness: re-fetch current prices from Gamma; abort if either leg
 *      has drifted beyond maxSlippageBps from the signal's detected price.
 *
 * **Leg sequencing heuristic**:
 *   We place the leg with greater ask-side CLOB depth (at the execution price
 *   ± maxSlippageBps) first. A deeper book at our price means the order fills
 *   faster and is less likely to time out, which is the primary source of
 *   unwind risk. Ties are broken by placing Leg A first.
 *
 * **Failure paths**:
 *   - Leg 1 order rejected or times out: aborted (no unwind needed).
 *   - Leg 1 filled, Leg 2 fails or times out: immediate market SELL of leg 1
 *     position, logged as "failed-arb-unwind".
 *
 * **On success**:
 *   - riskManager.recordPnl() is called with the realized P&L.
 *   - A paper_trade row is inserted with trading_mode='live', status='settled'.
 */
export async function executeLogicArbTrade(
  signal:    LogicArbSignal,
  sizingPct: number,
  deps:      ExecutorDeps,
  config:    ExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
): Promise<ExecutionResult> {
  const { tradingService, riskManager, supabase } = deps;
  const { maxSlippageBps, fillTimeoutMs, pollIntervalMs = 500, maxPositionSizeUsdc } = config;
  const log = createLogger('logic-arb-executor');

  const abort = (reason: ExecutionAbortReason, detail: string): ExecutionResult => {
    log.warn('Trade aborted', { reason, detail, pairId: signal.pairId });
    return { status: 'aborted', reason, detail };
  };

  // ── 1. Wallet balance ──────────────────────────────────────────────────────
  let balanceUsdc: number;
  try {
    const bal = await tradingService.getBalanceAllowance('COLLATERAL');
    balanceUsdc = parseFloat(bal.balance);
  } catch (err) {
    return abort('insufficient-balance', `Balance fetch failed: ${String(err)}`);
  }

  // ── 2. Position sizing ────────────────────────────────────────────────────
  const shares = computeLogicArbShares(
    balanceUsdc,
    sizingPct,
    maxPositionSizeUsdc,
    signal.trade.legA.price,
    signal.trade.legB.price,
  );

  if (shares < MIN_ORDER_SIZE_SHARES) {
    const totalCost = (signal.trade.legA.price + signal.trade.legB.price) * MIN_ORDER_SIZE_SHARES;
    return abort(
      'insufficient-balance',
      `Computed shares (${shares}) < minimum (${MIN_ORDER_SIZE_SHARES}). ` +
      `Balance $${balanceUsdc.toFixed(2)}, need $${totalCost.toFixed(2)} for min position.`,
    );
  }

  const legACostUsdc  = signal.trade.legA.price * shares;
  const legBCostUsdc  = signal.trade.legB.price * shares;
  const totalCostUsdc = legACostUsdc + legBCostUsdc;

  if (totalCostUsdc > balanceUsdc) {
    return abort(
      'insufficient-balance',
      `Total cost $${totalCostUsdc.toFixed(2)} exceeds balance $${balanceUsdc.toFixed(2)}`,
    );
  }

  // ── 3. Risk gate — both legs ───────────────────────────────────────────────
  const checkA = await riskManager.checkOrder(MODULE, signal.marketAConditionId, 'BUY', legACostUsdc, signal.trade.legA.price);
  if (!checkA.allowed) {
    return abort('risk-gate-leg-a', `Leg A blocked: ${checkA.reason}`);
  }

  const checkB = await riskManager.checkOrder(MODULE, signal.marketBConditionId, 'BUY', legBCostUsdc, signal.trade.legB.price);
  if (!checkB.allowed) {
    return abort('risk-gate-leg-b', `Leg B blocked: ${checkB.reason}`);
  }

  // ── 4. Price staleness check ───────────────────────────────────────────────
  // Re-fetch both markets from the Gamma API to get current prices.
  // Abort if either leg's current price has drifted beyond maxSlippageBps
  // from the price embedded in the signal (which may be seconds old).
  let freshPriceA: number | null = null;
  let freshPriceB: number | null = null;
  try {
    const [resA, resB] = await Promise.all([
      fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(signal.marketASlug)}&limit=1`),
      fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(signal.marketBSlug)}&limit=1`),
    ]);
    if (resA.ok) {
      const [m] = await resA.json() as Array<{ outcomePrices: number[]; closed?: boolean }>;
      if (m && !m.closed && Array.isArray(m.outcomePrices)) freshPriceA = Number(m.outcomePrices[0]);
    }
    if (resB.ok) {
      const [m] = await resB.json() as Array<{ outcomePrices: number[]; closed?: boolean }>;
      if (m && !m.closed && Array.isArray(m.outcomePrices)) freshPriceB = Number(m.outcomePrices[0]);
    }
  } catch { /* fall through — staleness check requires fresh prices */ }

  if (freshPriceA === null || freshPriceB === null) {
    return abort('price-stale', 'Could not re-fetch current prices from Gamma API');
  }

  // The signal prices are YES prices. The legs may be YES or NO.
  // Signal's priceA = YES price of market A; signal's priceB = YES price of market B.
  // Leg prices: legA.price = priceB (YES-B) or 1-priceA (NO-A), legB similarly.
  // For staleness we compare the signal's detected YES prices against fresh YES prices.
  const slippageThreshold = maxSlippageBps / 10_000;
  if (Math.abs(freshPriceA - signal.priceA) > signal.priceA * slippageThreshold) {
    return abort('price-stale',
      `Market A price drifted: signal=${signal.priceA.toFixed(4)} fresh=${freshPriceA.toFixed(4)} ` +
      `(>${maxSlippageBps} bps)`);
  }
  if (Math.abs(freshPriceB - signal.priceB) > signal.priceB * slippageThreshold) {
    return abort('price-stale',
      `Market B price drifted: signal=${signal.priceB.toFixed(4)} fresh=${freshPriceB.toFixed(4)} ` +
      `(>${maxSlippageBps} bps)`);
  }

  // ── 5. Fetch CLOB token IDs ────────────────────────────────────────────────
  const [infoA, infoB] = await Promise.all([
    fetchClobMarketInfo(signal.marketAConditionId),
    fetchClobMarketInfo(signal.marketBConditionId),
  ]);

  if (!infoA || !infoB) {
    return abort('token-ids-unavailable',
      `CLOB market info unavailable for ${!infoA ? signal.marketAConditionId : signal.marketBConditionId}`);
  }

  function getTokenId(info: ClobMarketInfo, outcome: 'YES' | 'NO'): string | null {
    const needle = outcome === 'YES' ? 'yes' : 'no';
    const tok = info.tokens.find(t => t.outcome.toLowerCase() === needle);
    return tok?.token_id ?? null;
  }

  const tokenIdA = getTokenId(infoA, signal.trade.legA.token);
  const tokenIdB = getTokenId(infoB, signal.trade.legB.token);

  if (!tokenIdA || !tokenIdB) {
    return abort('token-ids-unavailable',
      `Token ID not found — legA.token=${signal.trade.legA.token} tokenIdA=${tokenIdA}, ` +
      `legB.token=${signal.trade.legB.token} tokenIdB=${tokenIdB}`);
  }

  // ── 6. Leg sequencing by order book depth ─────────────────────────────────
  // Query ask-side CLOB depth for each leg at the execution price.
  // Place the leg with MORE available liquidity first to minimise fill timeout risk.
  //
  // Depth metric: sum of ask sizes at prices ≤ legPrice × (1 + maxSlippageBps/10_000).
  // A leg with more depth is more likely to fill quickly and cleanly, making it
  // safer to execute first (so the expensive unwind path is less likely to trigger).
  const [depthA, depthB] = await Promise.all([
    fetchAskDepthAtPrice(tokenIdA, signal.trade.legA.price, maxSlippageBps),
    fetchAskDepthAtPrice(tokenIdB, signal.trade.legB.price, maxSlippageBps),
  ]);

  log.info('Leg sequencing', {
    pairId:   signal.pairId,
    depthA,   depthB,
    firstLeg: depthA >= depthB ? 'A' : 'B',
  });

  // 'first' = the leg we place first (better liquidity)
  const [firstTokenId, secondTokenId, firstPrice, secondPrice, firstCondId, , firstLabel, firstCost, secondCost] =
    depthA >= depthB
      ? [tokenIdA, tokenIdB, signal.trade.legA.price, signal.trade.legB.price, signal.marketAConditionId, signal.marketBConditionId, 'A' as const, legACostUsdc, legBCostUsdc]
      : [tokenIdB, tokenIdA, signal.trade.legB.price, signal.trade.legA.price, signal.marketBConditionId, signal.marketAConditionId, 'B' as const, legBCostUsdc, legACostUsdc];

  void firstCondId; void secondCost;  // referenced for symmetry; not needed in execution body

  // ── 6b. Pre-placement price check ─────────────────────────────────────────
  // The CLOB depth fetches above take additional network time during which prices
  // can continue to drift. Re-validate immediately before placing leg 1 so the
  // total unguarded window is bounded to only this final fetch pair.
  let freshPriceA2: number | null = null;
  let freshPriceB2: number | null = null;
  try {
    const [resA2, resB2] = await Promise.all([
      fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(signal.marketASlug)}&limit=1`),
      fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(signal.marketBSlug)}&limit=1`),
    ]);
    if (resA2.ok) {
      const [m] = await resA2.json() as Array<{ outcomePrices: number[]; closed?: boolean }>;
      if (m && !m.closed && Array.isArray(m.outcomePrices)) freshPriceA2 = Number(m.outcomePrices[0]);
    }
    if (resB2.ok) {
      const [m] = await resB2.json() as Array<{ outcomePrices: number[]; closed?: boolean }>;
      if (m && !m.closed && Array.isArray(m.outcomePrices)) freshPriceB2 = Number(m.outcomePrices[0]);
    }
  } catch { /* treat as stale if prices unavailable */ }

  if (freshPriceA2 === null || freshPriceB2 === null) {
    return abort('price-stale', 'Could not re-fetch prices for pre-placement check (step 6b)');
  }
  if (Math.abs(freshPriceA2 - signal.priceA) > signal.priceA * slippageThreshold) {
    return abort('price-stale',
      `Market A pre-placement drift: signal=${signal.priceA.toFixed(4)} fresh=${freshPriceA2.toFixed(4)} ` +
      `(>${maxSlippageBps} bps)`);
  }
  if (Math.abs(freshPriceB2 - signal.priceB) > signal.priceB * slippageThreshold) {
    return abort('price-stale',
      `Market B pre-placement drift: signal=${signal.priceB.toFixed(4)} fresh=${freshPriceB2.toFixed(4)} ` +
      `(>${maxSlippageBps} bps)`);
  }

  // ── 7. Place leg 1 ────────────────────────────────────────────────────────
  log.info('Placing leg 1', { leg: firstLabel, tokenId: firstTokenId, price: firstPrice, shares });
  const leg1Result = await tradingService.createLimitOrder({
    tokenId:   firstTokenId,
    side:      'BUY',
    price:     firstPrice,
    size:      shares,
    orderType: 'GTC',
  });

  if (!leg1Result.success || !leg1Result.orderId) {
    return abort('leg1-order-failed', `Leg 1 order rejected: ${leg1Result.errorMsg ?? 'unknown'}`);
  }

  // ── 8. Wait for leg 1 fill ────────────────────────────────────────────────
  log.info('Waiting for leg 1 fill', { orderId: leg1Result.orderId, timeoutMs: fillTimeoutMs });
  const leg1Filled = await waitForFill(tradingService, leg1Result.orderId, fillTimeoutMs, pollIntervalMs);

  if (!leg1Filled) {
    // Determine how much of leg 1 was partially filled before cancellation.
    // getOpenOrders returns filledSize via the CLOB's size_matched field.
    // If the order disappeared between the last poll and this lookup it may have
    // raced to a full fill — in that case partialFillShares stays 0 and we abort.
    let partialFillShares = 0;
    try {
      const openOrders = await tradingService.getOpenOrders();
      const pendingOrder = openOrders.find(o => o.id === leg1Result.orderId);
      if (pendingOrder) partialFillShares = pendingOrder.filledSize ?? 0;
    } catch { /* best effort — assume no partial fill if query fails */ }

    // Cancel whatever remains unfilled
    try { await tradingService.cancelOrder(leg1Result.orderId); } catch { /* best effort */ }

    if (partialFillShares > 0) {
      // Partial fill exists — unwind the filled portion
      const partialCostUsdc = partialFillShares * firstPrice;
      log.warn('Leg 1 partial fill on timeout — unwinding', {
        pairId:          signal.pairId,
        leg:             firstLabel,
        partialFillShares,
        requestedShares: shares,
        partialCostUsdc,
      });

      const unwindOutcome = await performUnwind(
        tradingService, riskManager, log,
        firstTokenId, partialCostUsdc, partialFillShares,
        firstPrice, firstLabel, signal,
        `Leg 1 (${firstLabel}) partial fill timeout — ${partialFillShares} of ${shares} shares filled`,
      );

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from('paper_trades').insert({
          module:         MODULE,
          market_label:   `[UNWIND] ${signal.marketASlug} / ${signal.marketBSlug}`,
          net_profit_usd: -(partialCostUsdc),
          shares:         partialFillShares,
          trading_mode:   'live',
          status:         unwindOutcome.success ? 'settled' : 'open',
          metadata: {
            type:            unwindOutcome.success ? 'failed-arb-unwind' : 'unwind-double-failure',
            pairId:          signal.pairId,
            signal,
            leg1TokenId:     firstTokenId,
            leg1FillPrice:   firstPrice,
            leg1CostUsdc:    partialCostUsdc,
            partialFill:     true,
            requestedShares: shares,
            unwindSuccess:   unwindOutcome.success,
            unwindRetried:   unwindOutcome.retried,
            unwindOrderId:   unwindOutcome.orderId,
          },
        });
      } catch (insertErr) {
        log.error('Failed to insert partial-fill unwind audit row', { error: String(insertErr) });
      }

      return {
        status:        'unwind',
        leg1FillPrice: firstPrice,
        leg1Shares:    partialFillShares,
        unwindSuccess: unwindOutcome.success,
        detail: `Leg 1 timed out — partial fill (${partialFillShares}/${shares} shares) unwound ${unwindOutcome.success ? 'ok' : 'FAILED'}${unwindOutcome.retried ? ' (after retry)' : ''}`,
      };
    }

    // No partial fill — clean abort
    return abort('leg1-timeout',
      `Leg 1 (${firstLabel}) did not fill within ${fillTimeoutMs} ms — order cancelled`);
  }

  // Leg 1 confirmed filled. Determine actual fill price (use signal price as proxy
  // since getOpenOrders doesn't return fill prices — the real price is ≤ the limit price).
  const leg1FillPrice = firstPrice;

  // ── 9. Place leg 2 ────────────────────────────────────────────────────────
  const secondLabel = firstLabel === 'A' ? 'B' : 'A';
  log.info('Placing leg 2', { leg: secondLabel, tokenId: secondTokenId, price: secondPrice, shares });
  const leg2Result = await tradingService.createLimitOrder({
    tokenId:   secondTokenId,
    side:      'BUY',
    price:     secondPrice,
    size:      shares,
    orderType: 'GTC',
  });

  if (!leg2Result.success || !leg2Result.orderId) {
    // Leg 2 order rejected — unwind leg 1 immediately
    const unwindOutcome = await performUnwind(
      tradingService, riskManager, log,
      firstTokenId, firstCost, shares, leg1FillPrice, firstLabel, signal,
      `Leg 2 (${secondLabel}) order rejected: ${leg2Result.errorMsg ?? 'unknown'}`,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('paper_trades').insert({
        module:         MODULE,
        market_label:   `[UNWIND] ${signal.marketASlug} / ${signal.marketBSlug}`,
        net_profit_usd: -(firstCost),
        shares,
        trading_mode:   'live',
        status:         unwindOutcome.success ? 'settled' : 'open',
        metadata: {
          type:          unwindOutcome.success ? 'failed-arb-unwind' : 'unwind-double-failure',
          pairId:        signal.pairId,
          signal,
          leg1TokenId:   firstTokenId,
          leg1FillPrice,
          leg1CostUsdc:  firstCost,
          unwindSuccess: unwindOutcome.success,
          unwindRetried: unwindOutcome.retried,
          unwindOrderId: unwindOutcome.orderId,
          triggerReason: `Leg 2 rejected: ${leg2Result.errorMsg ?? 'unknown'}`,
        },
      });
    } catch (insertErr) {
      log.error('Failed to insert unwind audit row', { error: String(insertErr) });
    }

    return {
      status:        'unwind',
      leg1FillPrice,
      leg1Shares:    shares,
      unwindSuccess: unwindOutcome.success,
      detail: `Leg 2 rejected (${leg2Result.errorMsg ?? 'unknown'}); unwind ${unwindOutcome.success ? 'succeeded' : 'FAILED'}${unwindOutcome.retried ? ' (after retry)' : ''}`,
    };
  }

  // ── 10. Wait for leg 2 fill ───────────────────────────────────────────────
  log.info('Waiting for leg 2 fill', { orderId: leg2Result.orderId, timeoutMs: fillTimeoutMs });
  const leg2Filled = await waitForFill(tradingService, leg2Result.orderId, fillTimeoutMs, pollIntervalMs);

  if (!leg2Filled) {
    // Cancel leg 2, then unwind leg 1 with a market sell
    try { await tradingService.cancelOrder(leg2Result.orderId); } catch { /* best effort */ }

    const unwindOutcome = await performUnwind(
      tradingService, riskManager, log,
      firstTokenId, firstCost, shares, leg1FillPrice, firstLabel, signal,
      `Leg 2 (${secondLabel}) did not fill within ${fillTimeoutMs} ms`,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('paper_trades').insert({
        module:         MODULE,
        market_label:   `[UNWIND] ${signal.marketASlug} / ${signal.marketBSlug}`,
        net_profit_usd: -(firstCost),
        shares,
        trading_mode:   'live',
        status:         unwindOutcome.success ? 'settled' : 'open',
        metadata: {
          type:          unwindOutcome.success ? 'failed-arb-unwind' : 'unwind-double-failure',
          pairId:        signal.pairId,
          signal,
          leg1TokenId:   firstTokenId,
          leg1FillPrice,
          leg1CostUsdc:  firstCost,
          unwindSuccess: unwindOutcome.success,
          unwindRetried: unwindOutcome.retried,
          unwindOrderId: unwindOutcome.orderId,
        },
      });
    } catch (insertErr) {
      log.error('Failed to insert unwind audit row', { error: String(insertErr) });
    }

    return {
      status:        'unwind',
      leg1FillPrice,
      leg1Shares:    shares,
      unwindSuccess: unwindOutcome.success,
      detail: `Leg 2 timed out after ${fillTimeoutMs} ms; unwind ${unwindOutcome.success ? 'succeeded' : 'FAILED'}${unwindOutcome.retried ? ' (after retry)' : ''}`,
    };
  }

  const leg2FillPrice = secondPrice;

  // ── 11. Both legs filled — record success ─────────────────────────────────
  // Compute realized P&L using actual fill prices.
  // Guaranteed payout is $1/share; cost is leg1FillPrice + leg2FillPrice.
  const guaranteedGross = shares * 1;  // minimum guaranteed payout per share
  const actualCost      = (leg1FillPrice + leg2FillPrice) * shares;
  const realizedPnl     = guaranteedGross - actualCost;  // ignores fees (deducted by exchange)

  log.info('Both legs filled — arb complete', {
    pairId: signal.pairId,
    leg1FillPrice, leg2FillPrice, shares,
    realizedPnl,
  });

  // Record P&L in risk manager
  try {
    await riskManager.recordPnl(MODULE, signal.marketAConditionId, realizedPnl);
  } catch (pnlErr) {
    log.error('recordPnl failed', { error: String(pnlErr) });
  }

  // Persist live trade to paper_trades table
  const label = `${signal.marketASlug} / ${signal.marketBSlug}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('paper_trades').insert({
      module:         MODULE,
      market_label:   label,
      net_profit_usd: realizedPnl,
      shares,
      trading_mode:   'live',
      status:         'settled',
      metadata: {
        type:           'live-execution',
        pairId:         signal.pairId,
        signal,
        leg1TokenId:    firstTokenId,
        leg2TokenId:    secondTokenId,
        leg1FillPrice,
        leg2FillPrice,
        realizedPnl,
      },
    });
  } catch (insertErr) {
    log.error('Failed to insert live trade row', { error: String(insertErr) });
  }

  return { status: 'success', leg1FillPrice, leg2FillPrice, shares, realizedPnl };
}
