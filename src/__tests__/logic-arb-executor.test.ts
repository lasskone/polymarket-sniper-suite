/**
 * Tests for logic-arb live execution engine.
 *
 * Tests the pure computeLogicArbShares function and the executeLogicArbTrade
 * function via mocked deps — no imports of bot/index.ts.
 *
 * Key test cases:
 *   1. computeLogicArbShares — sizing math (floor, cap, zero-guard)
 *   2. Successful two-leg execution — recordPnl called, live trade inserted
 *   3. Leg-2 timeout triggers leg-1 unwind — market SELL fired, audit row inserted
 *   4. Price staleness abort — 'price-stale' reason
 *   5. Insufficient balance abort — balance too low
 *   6. RiskManager rejection abort — 'risk-gate-leg-a' reason
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeLogicArbTrade,
  computeLogicArbShares,
  type ExecutorDeps,
  type ExecutorConfig,
} from '../services/logic-arb-executor.js';
import type { LogicArbSignal } from '../services/logic-arb-types.js';
import { MIN_ORDER_SIZE_SHARES } from '../services/trading-service.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSignal(overrides?: Partial<LogicArbSignal>): LogicArbSignal {
  return {
    pairId:             'pair-uuid-1',
    marketAConditionId: '0xcondA',
    marketBConditionId: '0xcondB',
    marketASlug:        'market-a-slug',
    marketBSlug:        'market-b-slug',
    relationship:       'a_implies_b',
    priceA:             0.70,
    priceB:             0.60,
    deviation:          0.10,
    netProfitUSD:       0.82,
    shares:             10,
    feeRate:            0.04,
    trade: {
      legA: { token: 'NO',  price: 0.30 },  // NO-A at 1-0.70=0.30
      legB: { token: 'YES', price: 0.60 },  // YES-B at 0.60
    },
    ...overrides,
  };
}

// Default executor config (short timeouts for fast tests)
const TEST_CONFIG: ExecutorConfig = {
  maxSlippageBps:      50,
  fillTimeoutMs:       100,   // very short for fast tests
  pollIntervalMs:      10,
  maxPositionSizeUsdc: 1000,
};

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<ExecutorDeps>): ExecutorDeps {
  const tradingService = {
    getBalanceAllowance: vi.fn().mockResolvedValue({ balance: '500', allowance: '500' }),
    createLimitOrder:    vi.fn().mockResolvedValue({ success: true, orderId: 'order-leg1' }),
    createMarketOrder:   vi.fn().mockResolvedValue({ success: true, orderId: 'unwind-order' }),
    getOpenOrders:       vi.fn().mockResolvedValue([]),  // no open orders = filled
    cancelOrder:         vi.fn().mockResolvedValue({ success: true }),
  };
  const riskManager = {
    checkOrder:     vi.fn().mockResolvedValue({ allowed: true, reason: 'ok', adjustedSize: 0 }),
    recordPnl:      vi.fn().mockResolvedValue(undefined),
    emergencyPause: vi.fn().mockResolvedValue(undefined),
  };
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const supabase = {
    from: vi.fn().mockReturnValue({
      insert: insertMock,
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
  return {
    tradingService: tradingService as unknown as ExecutorDeps['tradingService'],
    riskManager:    riskManager   as unknown as ExecutorDeps['riskManager'],
    supabase:       supabase       as unknown as ExecutorDeps['supabase'],
    ...overrides,
  };
}

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchSuccess() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/markets/0xcondA') || u.includes('/markets/0xcondB')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          tokens: [
            { token_id: 'yes-token-a', outcome: 'Yes' },
            { token_id: 'no-token-a',  outcome: 'No' },
          ],
          taker_base_fee: 400,
        }),
      });
    }
    if (u.includes('/book?')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ asks: [{ price: '0.31', size: '50' }], bids: [] }),
      });
    }
    if (u.includes('gamma-api.polymarket.com')) {
      if (u.includes('market-a-slug')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ outcomePrices: [0.70, 0.30], closed: false }]) });
      }
      if (u.includes('market-b-slug')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ outcomePrices: [0.60, 0.40], closed: false }]) });
      }
    }
    return Promise.resolve({ ok: false });
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeLogicArbShares', () => {
  it('basic sizing: balance×pct / costPerPair, floored', () => {
    // balance=500, pct=2 → targetUsdc=10; costPerPair=0.30+0.60=0.90
    // shares = floor(min(10, 1000) / 0.90) = floor(11.11) = 11
    expect(computeLogicArbShares(500, 2, 1000, 0.30, 0.60)).toBe(11);
  });

  it('cap: maxPositionSizeUsdc limits targetUsdc', () => {
    // balance=10000, pct=2 → targetUsdc=200; maxPos=50; costPerPair=0.90
    // shares = floor(min(200, 50) / 0.90) = floor(55.55) = 55
    expect(computeLogicArbShares(10_000, 2, 50, 0.30, 0.60)).toBe(55);
  });

  it('returns 0 when costPerPair is 0', () => {
    expect(computeLogicArbShares(500, 2, 1000, 0, 0)).toBe(0);
  });

  it('floors to integer', () => {
    // targetUsdc=7, costPerPair=3 → floor(2.33) = 2
    expect(computeLogicArbShares(350, 2, 1000, 1.5, 1.5)).toBe(2);
  });

  it('MIN_ORDER_SIZE_SHARES is 5 (constant guard)', () => {
    // This test ensures MIN_ORDER_SIZE_SHARES hasn't been accidentally changed.
    expect(MIN_ORDER_SIZE_SHARES).toBe(5);
  });
});

describe('executeLogicArbTrade', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('successful two-leg execution — returns success, calls recordPnl, inserts live trade', async () => {
    mockFetchSuccess();
    const deps = makeDeps();

    (deps.tradingService.createLimitOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg1' })
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg2' });

    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.shares).toBeGreaterThanOrEqual(MIN_ORDER_SIZE_SHARES);
      expect(typeof result.realizedPnl).toBe('number');
    }
    // recordPnl called once on success
    expect(deps.riskManager.recordPnl).toHaveBeenCalledOnce();
    // paper_trades insert with trading_mode='live'
    const fromMock = deps.supabase.from as ReturnType<typeof vi.fn>;
    expect(fromMock).toHaveBeenCalledWith('paper_trades');
  });

  it('leg-2 timeout triggers unwind of leg-1', async () => {
    mockFetchSuccess();
    const deps = makeDeps();

    (deps.tradingService.createLimitOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg1' })
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg2' });

    // leg1 fills (getOpenOrders returns empty for the first poll)
    // leg2 never fills (getOpenOrders always returns order-leg2 present after that)
    let callCount = 0;
    (deps.tradingService.getOpenOrders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [];  // leg1 filled
      return [{ id: 'order-leg2' }];  // leg2 never fills
    });

    const p = executeLogicArbTrade(makeSignal(), 2, deps, { ...TEST_CONFIG, fillTimeoutMs: 50 });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('unwind');
    // Market SELL should have been called for leg 1 unwind
    expect(deps.tradingService.createMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', orderType: 'FOK' })
    );
    // Audit row inserted into paper_trades
    const fromMock = deps.supabase.from as ReturnType<typeof vi.fn>;
    expect(fromMock).toHaveBeenCalledWith('paper_trades');
  });

  it('price staleness abort — market A drifted > 50 bps', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/markets/0xcondA') || u.includes('/markets/0xcondB')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            tokens: [{ token_id: 'tok', outcome: 'Yes' }],
            taker_base_fee: 400,
          }),
        });
      }
      if (u.includes('/book')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ asks: [], bids: [] }) });
      if (u.includes('market-a-slug')) {
        // Price drifted: signal was 0.70, now 0.76 = +8.57% >> 50 bps
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ outcomePrices: [0.76, 0.24], closed: false }]) });
      }
      if (u.includes('market-b-slug')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ outcomePrices: [0.60, 0.40], closed: false }]) });
      }
      return Promise.resolve({ ok: false });
    }));

    const deps = makeDeps();
    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('aborted');
    expect((result as { reason: string }).reason).toBe('price-stale');
    expect(deps.tradingService.createLimitOrder).not.toHaveBeenCalled();
  });

  it('insufficient balance abort — balance too low for MIN_ORDER_SIZE_SHARES', async () => {
    const deps = makeDeps();
    // Balance $0.5; min cost = (0.30 + 0.60) × 5 = $4.50 → shares=0 < 5
    (deps.tradingService.getBalanceAllowance as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ balance: '0.5', allowance: '0.5' });

    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('aborted');
    expect((result as { reason: string }).reason).toBe('insufficient-balance');
    // Risk gate should NOT have been consulted
    expect(deps.riskManager.checkOrder).not.toHaveBeenCalled();
  });

  it('riskManager rejection on leg A — aborts without placing any orders', async () => {
    mockFetchSuccess();
    const deps = makeDeps();
    (deps.riskManager.checkOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ allowed: false, reason: 'daily loss limit', adjustedSize: 0 });

    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('aborted');
    expect((result as { reason: string }).reason).toBe('risk-gate-leg-a');
    expect(deps.tradingService.createLimitOrder).not.toHaveBeenCalled();
  });

  it('leg-1 timeout with partial fill — cancels then unwinds partial amount', async () => {
    mockFetchSuccess();
    const deps = makeDeps();

    (deps.tradingService.createLimitOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg1' });

    // leg 1 never fully fills — every poll sees it still open with filledSize=3
    (deps.tradingService.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'order-leg1', filledSize: 3, originalSize: 11, remainingSize: 8 },
    ]);

    const p = executeLogicArbTrade(makeSignal(), 2, deps, { ...TEST_CONFIG, fillTimeoutMs: 50 });
    await vi.runAllTimersAsync();
    const result = await p;

    // Partial fill → unwind, not a clean abort
    expect(result.status).toBe('unwind');
    if (result.status === 'unwind') {
      expect(result.leg1Shares).toBe(3);
    }
    // Cancel attempted before unwind
    expect(deps.tradingService.cancelOrder).toHaveBeenCalledWith('order-leg1');
    // FOK SELL fired for the partial amount
    expect(deps.tradingService.createMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', orderType: 'FOK' }),
    );
    // Audit row inserted
    expect(deps.supabase.from).toHaveBeenCalledWith('paper_trades');
  });

  it('unwind double-failure — retries FOK then triggers emergencyPause', async () => {
    mockFetchSuccess();
    const deps = makeDeps();

    (deps.tradingService.createLimitOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg1' })
      .mockResolvedValueOnce({ success: true, orderId: 'order-leg2' });

    // leg1 fills on first poll; leg2 never fills
    let pollCount = 0;
    (deps.tradingService.getOpenOrders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) return [];
      return [{ id: 'order-leg2' }];
    });

    // Both unwind attempts fail
    (deps.tradingService.createMarketOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, errorMsg: 'no liquidity' });

    const p = executeLogicArbTrade(makeSignal(), 2, deps, { ...TEST_CONFIG, fillTimeoutMs: 50 });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('unwind');
    if (result.status === 'unwind') {
      expect(result.unwindSuccess).toBe(false);
    }
    // Two FOK SELL attempts (initial + retry)
    expect(deps.tradingService.createMarketOrder).toHaveBeenCalledTimes(2);
    // Emergency pause triggered on the risk manager
    expect(deps.riskManager.emergencyPause).toHaveBeenCalledWith(
      'logic-arb',
      expect.stringContaining('Unwind double-failure'),
    );
  });

  it('second staleness check (step 6b) aborts if price drifts between depth-fetch and placement', async () => {
    let marketAGammaCount = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      // CLOB market info (step 5 — token IDs)
      if (u.includes('clob.polymarket.com/markets/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            tokens: [
              { token_id: 'yes-token-a', outcome: 'Yes' },
              { token_id: 'no-token-a',  outcome: 'No' },
            ],
            taker_base_fee: 400,
          }),
        });
      }
      // CLOB order book depth (step 6)
      if (u.includes('/book?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ asks: [{ price: '0.31', size: '50' }], bids: [] }),
        });
      }
      // Gamma prices (step 4 first check, then step 6b second check)
      if (u.includes('gamma-api.polymarket.com')) {
        if (u.includes('market-a-slug')) {
          marketAGammaCount++;
          // First call (step 4): within tolerance; second call (step 6b): drifted > 50 bps
          const price = marketAGammaCount === 1 ? 0.70 : 0.76;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ outcomePrices: [price, 1 - price], closed: false }]),
          });
        }
        if (u.includes('market-b-slug')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ outcomePrices: [0.60, 0.40], closed: false }]),
          });
        }
      }
      return Promise.resolve({ ok: false });
    }));

    const deps = makeDeps();
    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('aborted');
    expect((result as { reason: string }).reason).toBe('price-stale');
    // No order should have been placed
    expect(deps.tradingService.createLimitOrder).not.toHaveBeenCalled();
  });

  it('riskManager rejection on leg B — aborts after leg A passes', async () => {
    mockFetchSuccess();
    const deps = makeDeps();
    (deps.riskManager.checkOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ allowed: true, reason: 'ok', adjustedSize: 0 })   // leg A passes
      .mockResolvedValueOnce({ allowed: false, reason: 'market exposure', adjustedSize: 0 }); // leg B blocked

    const p = executeLogicArbTrade(makeSignal(), 2, deps, TEST_CONFIG);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.status).toBe('aborted');
    expect((result as { reason: string }).reason).toBe('risk-gate-leg-b');
    expect(deps.tradingService.createLimitOrder).not.toHaveBeenCalled();
  });
});
