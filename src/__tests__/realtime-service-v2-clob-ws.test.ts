/**
 * Unit tests for the ClobMarketWsClient integration inside RealtimeServiceV2.
 *
 * These tests verify that subscribeMarkets() no longer routes through RTDS
 * (which stopped serving clob_market topics) and instead uses the direct
 * CLOB WebSocket at wss://ws-subscriptions-clob.polymarket.com/ws/market.
 *
 * What is tested:
 *   1. subscribeMarkets() creates a WebSocket to the correct URL
 *   2. Subscribe message shape is correct (assets_ids, type, initial_dump, level)
 *   3. A "book" event correctly populates the orderbook cache and emits 'orderbook'
 *   4. A "price_change" event emits 'priceChange' with the right assetId
 *   5. A "last_trade_price" event emits 'lastTrade'
 *   6. An unexpected disconnect (code 1006) schedules a reconnect with backoff
 *   7. An explicit disconnect() does NOT trigger a reconnect
 *   8. PING is sent periodically on the active socket
 *   9. PONG responses do not emit spurious events
 *  10. A second subscribeMarkets() call subscribes only the new (delta) token IDs
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mock WebSocket (ws package)
// ============================================================================
//
// vi.hoisted() runs BEFORE any module import, so the factory must not
// reference any imported symbols (EventEmitter, etc.).  We implement a
// minimal manual event emitter here.

const { MockWs, mockInstances } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockInstances: any[] = [];

  class MockWsType {
    static OPEN        = 1;
    static CONNECTING  = 0;
    static CLOSING     = 2;
    static CLOSED      = 3;

    readyState = 0; // CONNECTING
    sent: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handlers: Record<string, ((...a: any[]) => void)[]> = {};

    constructor(public url: string) {
      mockInstances.push(this);
    }

    // Minimal EventEmitter surface used by ClobMarketWsClient
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...a: any[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }

    removeAllListeners(event?: string) {
      if (event) delete this.handlers[event];
      else       this.handlers = {};
      return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(event: string, ...args: any[]) {
      for (const cb of (this.handlers[event] ?? [])) cb(...args);
    }

    send(data: string) { this.sent.push(data); }

    close() {
      this.readyState = MockWsType.CLOSED;
      this.emit('close', 1000);
    }

    // ── Test helpers ─────────────────────────────────────────────────────────

    simulateOpen() {
      this.readyState = MockWsType.OPEN;
      this.emit('open');
    }

    /** Simulate an incoming text frame from the server. */
    simulateMessage(raw: string) {
      // ws 'message' handler receives RawData which has .toString()
      this.emit('message', { toString: () => raw });
    }

    simulateClose(code = 1006) {
      this.readyState = MockWsType.CLOSED;
      this.emit('close', code);
    }

    simulateError(msg = 'socket error') {
      this.emit('error', new Error(msg));
    }
  }

  return { MockWs: MockWsType, mockInstances };
});

vi.mock('ws', () => ({ default: MockWs }));

// Import AFTER the mock is registered
import { RealtimeServiceV2 } from '../services/realtime-service-v2.js';

// ============================================================================
// Helpers
// ============================================================================

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** The most recently created MockWs instance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function latestWs(): any {
  return mockInstances[mockInstances.length - 1];
}

const bookMsg = (assetId: string) =>
  JSON.stringify([{
    event_type:     'book',
    asset_id:       assetId,
    market:         'cond-id-test',
    bids:           [{ price: '0.44', size: '200' }],
    asks:           [{ price: '0.56', size: '200' }],
    timestamp:      '1720000000',
    tick_size:      '0.01',
    min_order_size: '1',
    hash:           'abc123',
  }]);

/**
 * Real CLOB WS shape: asset_id is INSIDE price_changes[0], NOT at root.
 * Confirmed against docs.polymarket.com (2026-07-13).
 */
const priceChangeMsg = (assetId: string) =>
  JSON.stringify([{
    event_type:    'price_change',
    market:        '0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1',
    price_changes: [{
      asset_id: assetId,
      price:    '0.5',
      size:     '200',
      side:     'BUY',
      hash:     '56621a121a47ed9333273e21c83b660cff37ae50',
      best_bid: '0.5',
      best_ask: '1',
    }],
    timestamp: '1757908892351',
  }]);

const lastTradeMsg = (assetId: string) =>
  JSON.stringify([{
    event_type: 'last_trade_price',
    asset_id:   assetId,
    price:      '0.45',
    side:       'BUY',
    size:       '10',
    timestamp:  '1720000002',
  }]);

// ============================================================================
// Tests
// ============================================================================

describe('RealtimeServiceV2 — ClobMarketWsClient (direct CLOB WebSocket)', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Correct URL ─────────────────────────────────────────────────────────

  it('subscribeMarkets() opens a WebSocket to the CLOB endpoint', () => {
    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['token-yes', 'token-no'], {});

    expect(mockInstances.length).toBe(1);
    expect(latestWs().url).toBe(CLOB_WS_URL);
  });

  // ── 2. Subscribe message shape ─────────────────────────────────────────────

  it('sends the correct subscribe message after the socket opens', () => {
    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-a', 'tok-b'], {});
    latestWs().simulateOpen();

    const msg = JSON.parse(latestWs().sent[0]);
    expect(msg).toMatchObject({
      assets_ids:             ['tok-a', 'tok-b'],
      type:                   'market',
      initial_dump:           true,
      level:                  2,
      custom_feature_enabled: false,
    });
  });

  // ── 3. "book" → 'orderbook' ────────────────────────────────────────────────

  it('emits "orderbook" and populates bookCache when a "book" event arrives', () => {
    const svc = new RealtimeServiceV2();
    const events: unknown[] = [];
    svc.on('orderbook', b => events.push(b));

    svc.subscribeMarkets(['token-abc'], {});
    latestWs().simulateOpen();
    latestWs().simulateMessage(bookMsg('token-abc'));

    expect(events.length).toBe(1);
    const book = events[0] as Record<string, unknown>;
    expect(book.tokenId).toBe('token-abc');
    expect(book.assetId).toBe('token-abc');       // backward-compat alias
    expect(book.bids).toEqual([{ price: 0.44, size: 200 }]);
    expect(book.asks).toEqual([{ price: 0.56, size: 200 }]);

    // Cache should be populated
    expect(svc.getBook('token-abc')?.tokenId).toBe('token-abc');
  });

  it('delivers "book" events only to handlers subscribed to that tokenId', () => {
    const svc = new RealtimeServiceV2();
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];

    svc.subscribeMarkets(['token-A'], { onOrderbook: b => eventsA.push(b) });
    svc.subscribeMarkets(['token-B'], { onOrderbook: b => eventsB.push(b) });

    latestWs().simulateOpen();
    latestWs().simulateMessage(bookMsg('token-A'));

    expect(eventsA.length).toBe(1);
    expect(eventsB.length).toBe(0);
  });

  // ── 4. "price_change" → 'priceChange' ─────────────────────────────────────

  it('emits "priceChange" when a "price_change" event arrives', () => {
    const svc = new RealtimeServiceV2();
    const changes: unknown[] = [];
    svc.on('priceChange', c => changes.push(c));

    svc.subscribeMarkets(['tok-x'], {});
    latestWs().simulateOpen();
    latestWs().simulateMessage(priceChangeMsg('tok-x'));

    expect(changes.length).toBe(1);
    const c = changes[0] as Record<string, unknown>;
    expect(c.assetId).toBe('tok-x');
    expect(Array.isArray(c.changes)).toBe(true);
  });

  // ── 5. "last_trade_price" → 'lastTrade' ───────────────────────────────────

  it('emits "lastTrade" when a "last_trade_price" event arrives', () => {
    const svc = new RealtimeServiceV2();
    const trades: unknown[] = [];
    svc.on('lastTrade', t => trades.push(t));

    svc.subscribeMarkets(['tok-y'], {});
    latestWs().simulateOpen();
    latestWs().simulateMessage(lastTradeMsg('tok-y'));

    expect(trades.length).toBe(1);
    const t = trades[0] as Record<string, unknown>;
    expect(t.assetId).toBe('tok-y');
    expect(t.price).toBeCloseTo(0.45);
    expect(t.side).toBe('BUY');
  });

  // ── 6. Reconnect after unexpected close ────────────────────────────────────

  it('schedules a reconnect after an unexpected close (code 1006)', async () => {
    vi.useFakeTimers();

    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-reconnect'], {});
    latestWs().simulateOpen();

    const countBefore = mockInstances.length;
    latestWs().simulateClose(1006);

    await vi.advanceTimersByTimeAsync(1500); // past the 1 s back-off

    expect(mockInstances.length).toBe(countBefore + 1);
    expect(latestWs().url).toBe(CLOB_WS_URL);
  });

  it('re-subscribes all active tokenIds after reconnect', async () => {
    vi.useFakeTimers();

    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-1', 'tok-2'], {});

    const ws1 = latestWs();
    ws1.simulateOpen();
    ws1.simulateClose(1006);

    await vi.advanceTimersByTimeAsync(1500);

    const ws2 = latestWs();
    ws2.simulateOpen();

    const subMsg = ws2.sent.find((s: string) => {
      try { return JSON.parse(s).type === 'market'; } catch { return false; }
    });
    expect(subMsg).toBeDefined();
    const parsed = JSON.parse(subMsg);
    expect(parsed.assets_ids).toContain('tok-1');
    expect(parsed.assets_ids).toContain('tok-2');
  });

  it('applies exponential backoff (1 s → 2 s → 4 s) on repeated failures', async () => {
    vi.useFakeTimers();

    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-backoff'], {});

    latestWs().simulateClose(1006);
    await vi.advanceTimersByTimeAsync(1100);
    expect(mockInstances.length).toBe(2);

    latestWs().simulateClose(1006);
    await vi.advanceTimersByTimeAsync(2100);
    expect(mockInstances.length).toBe(3);

    latestWs().simulateClose(1006);
    await vi.advanceTimersByTimeAsync(4100);
    expect(mockInstances.length).toBe(4);
  });

  // ── 7. No reconnect after explicit disconnect() ────────────────────────────

  it('does NOT reconnect after explicit disconnect()', async () => {
    vi.useFakeTimers();

    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-clean'], {});
    latestWs().simulateOpen();

    const countBefore = mockInstances.length;
    svc.disconnect();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockInstances.length).toBe(countBefore);
  });

  // ── 8. PING every 10 s ────────────────────────────────────────────────────

  it('sends PING every 10 s while connected', async () => {
    vi.useFakeTimers();

    const svc = new RealtimeServiceV2();
    svc.subscribeMarkets(['tok-ping'], {});
    latestWs().simulateOpen();

    await vi.advanceTimersByTimeAsync(25_000); // fires at 10 s and 20 s

    const pings = latestWs().sent.filter((s: string) => s === 'PING');
    expect(pings.length).toBeGreaterThanOrEqual(2);
  });

  // ── 9. PONG is silently discarded ─────────────────────────────────────────

  it('silently discards PONG responses without emitting any events', () => {
    const svc = new RealtimeServiceV2();
    const received: unknown[] = [];
    ['orderbook', 'priceChange', 'lastTrade', 'tickSizeChange'].forEach(ev =>
      svc.on(ev, (x: unknown) => received.push(x)),
    );

    svc.subscribeMarkets(['tok-pong'], {});
    latestWs().simulateOpen();
    latestWs().simulateMessage('PONG');

    expect(received.length).toBe(0);
  });

  // ── 10. Second subscribeMarkets() sends only the delta ────────────────────

  it('sends a second subscribe message with only the NEW tokenIds', () => {
    const svc = new RealtimeServiceV2();

    svc.subscribeMarkets(['tok-shared', 'tok-first-only'], {});
    latestWs().simulateOpen();

    const sentAfterFirst = latestWs().sent.length;

    svc.subscribeMarkets(['tok-shared', 'tok-second-only'], {});

    const newMsgs: string[] = latestWs().sent.slice(sentAfterFirst);
    const subMsg = newMsgs.find((s: string) => {
      try { return JSON.parse(s).type === 'market'; } catch { return false; }
    });

    expect(subMsg).toBeDefined();
    const parsed = JSON.parse(subMsg!);
    expect(parsed.assets_ids).toContain('tok-second-only');
    expect(parsed.assets_ids).not.toContain('tok-shared');       // already subscribed
    expect(parsed.assets_ids).not.toContain('tok-first-only');   // already subscribed
  });
});
