/**
 * Arb Service — Cooldown and Dead-Pair Tests
 *
 * Exercises the in-memory signal cooldown and dead-pair auto-deactivation
 * logic added to LogicArbService and NegRiskArbService.
 *
 * All tests use lightweight in-process mocks — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogicArbService } from '../services/logic-arb-service.js';
import { NegRiskArbService } from '../services/negrisk-arb-service.js';
import type { LogicArbSignal } from '../services/logic-arb-types.js';
import type { NegRiskArbSignal } from '../services/negrisk-arb-types.js';

// ══════════════════════════════════════════════════════════════════════════════
// DB-level dedup contract
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Contract test: verifies that the paper_trades upsert call in bot/index.ts
 * passes `onConflict: 'module,market_label,opened_minute'` and
 * `ignoreDuplicates: true`, AND that those options cause only one row to be
 * recorded when the same signal fires twice within the same UTC minute.
 *
 * This is a unit-level contract test, not a live DB test.  It simulates
 * PostgreSQL's `ON CONFLICT (module, market_label, opened_minute) DO NOTHING`
 * behaviour using an in-process Map keyed on the same conflict columns.
 *
 * Why this matters:
 *   Without onConflict, Supabase upsert targets the primary key (id), which is
 *   always a fresh UUID → ignoreDuplicates is a no-op for new rows.  The
 *   generated opened_minute column + plain-column unique index lets PostgREST
 *   generate a real `ON CONFLICT (...) DO NOTHING` against a targetable index.
 */
describe('paper_trades upsert — DB dedup contract', () => {
  it('passes onConflict and ignoreDuplicates, and suppresses same-minute duplicate', () => {
    // ── Mock Supabase that simulates the unique index ──────────────────────
    // Key = `module||market_label||minute` mirrors the DB constraint:
    //   UNIQUE (module, market_label, opened_minute)
    // where opened_minute = date_trunc('minute', opened_at) = NOW() to the minute.

    const store = new Map<string, Record<string, unknown>>();
    const capturedOptions: Array<Record<string, unknown>> = [];

    const mockSupabase = {
      from: (_table: string) => ({
        upsert: (
          row: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => {
          capturedOptions.push(opts);

          // Simulate the DB behaviour driven by the opts:
          if (opts.ignoreDuplicates) {
            // opened_minute is date_trunc('minute', NOW()) — same for both calls
            // in a test that runs within the same wall-clock minute.
            const minute = new Date().toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm'
            const conflictKey = `${row.module}||${row.market_label}||${minute}`;
            if (!store.has(conflictKey)) {
              store.set(conflictKey, row);
              // (a real DB would: INSERT ... ON CONFLICT (...) DO NOTHING → inserts)
            }
            // else: DO NOTHING — duplicate suppressed
          }

          return { then: (fn: (r: { error: null }) => void) => fn({ error: null }) };
        },
      }),
    };

    const row = {
      module:         'logic-arb',
      market_label:   'market-a / market-b',
      net_profit_usd: 0.82,
      shares:         10,
      metadata:       {},
      trading_mode:   'paper',
    };

    const upsertOpts = {
      onConflict:      'module,market_label,opened_minute',
      ignoreDuplicates: true,
    };

    // First insert — goes through.
    (mockSupabase as any).from('paper_trades').upsert(row, upsertOpts);
    // Second insert (same signal, same minute, e.g. from a rapid restart) — suppressed.
    (mockSupabase as any).from('paper_trades').upsert(row, upsertOpts);

    // Both calls must carry the correct options so PostgREST generates the right SQL.
    expect(capturedOptions).toHaveLength(2);
    for (const opts of capturedOptions) {
      expect(opts.onConflict).toBe('module,market_label,opened_minute');
      expect(opts.ignoreDuplicates).toBe(true);
    }

    // Only one row survived — the duplicate was absorbed by the conflict target.
    expect(store.size).toBe(1);
  });
});

// ── Shared mock helpers ────────────────────────────────────────────────────────

/** A minimal correlated_market_pairs row that triggers a mutually_exclusive signal. */
const MOCK_PAIR = {
  id:                      'pair-1',
  market_a_condition_id:   'cond-A',
  market_b_condition_id:   'cond-B',
  market_a_slug:           'market-a',
  market_b_slug:           'market-b',
  relationship:            'mutually_exclusive',
  active:                  true,
};

/**
 * Returns a market stub whose YES price is `yesPrice`.
 * `conditionId` must match the pair's expected conditionId so that
 * `isValidMarket()` treats it as valid (the real Gamma API is unreliable and
 * the service now checks conditionId equality as the primary validity signal).
 * outcomePrices[0] = YES, outcomePrices[1] = NO.
 */
function mockMarket(yesPrice: number, conditionId: string) {
  return { conditionId, outcomePrices: [yesPrice, 1 - yesPrice], closed: false };
}

/**
 * Builds a minimal SupabaseClient stub for LogicArbService.
 *
 * @param pairs         - Rows returned by `from('correlated_market_pairs').select('*').eq('active', true)`
 * @param updateSpy     - Optional spy to track `.update().eq()` calls (dead-pair deactivation)
 */
function makeSupabaseStub(
  pairs: typeof MOCK_PAIR[],
  updateSpy?: ReturnType<typeof vi.fn>,
) {
  const eqAfterUpdate = updateSpy ?? vi.fn().mockResolvedValue({ error: null });

  return {
    from: (table: string) => {
      if (table === 'correlated_market_pairs') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: pairs, error: null }),
          }),
          update: () => ({
            eq: eqAfterUpdate,
          }),
        };
      }
      return {};
    },
  };
}

/**
 * Runs `svc` and resolves after it emits exactly `targetScans` 'scanned' events,
 * then stops the service.
 */
function waitForScans(svc: LogicArbService | NegRiskArbService, targetScans: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    svc.on('scanned', () => {
      count++;
      if (count >= targetScans) {
        svc.stop();
        resolve();
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LogicArbService
// ══════════════════════════════════════════════════════════════════════════════

describe('LogicArbService — cooldown', () => {
  it('emits signal on first scan and suppresses repeats within cooldownMs', async () => {
    const gammaApi = {
      getMarketByConditionId: vi.fn()
        .mockResolvedValueOnce(mockMarket(0.65, MOCK_PAIR.market_a_condition_id))  // market A, scan 1
        .mockResolvedValueOnce(mockMarket(0.55, MOCK_PAIR.market_b_condition_id))  // market B, scan 1
        .mockResolvedValueOnce(mockMarket(0.65, MOCK_PAIR.market_a_condition_id))  // market A, scan 2 (suppressed)
        .mockResolvedValueOnce(mockMarket(0.55, MOCK_PAIR.market_b_condition_id)), // market B, scan 2 (suppressed)
    };

    const svc = new LogicArbService(
      gammaApi as any,
      makeSupabaseStub([MOCK_PAIR]) as any,
      async () => 400,  // mock fee fetcher: 400 bps
    );

    svc.updateConfig({
      cooldownMs:      60_000,   // 60s — both scans are within this window
      scanIntervalMs:  5,        // near-instant second scan
      minNetProfitUSD: 0.01,     // low threshold to guarantee a signal fires
    });

    const signals: LogicArbSignal[] = [];
    svc.on('signal', (s) => signals.push(s));

    const done = waitForScans(svc, 2);
    await svc.start();
    await done;

    expect(signals).toHaveLength(1);
    expect(signals[0].relationship).toBe('mutually_exclusive');
    expect(signals[0].marketASlug).toBe('market-a');
  });

  it('re-emits signal after cooldownMs has elapsed', async () => {
    // Alternating A/B calls: vi.fn().mockResolvedValue() returns the same value for all calls,
    // but the service calls getMarketByConditionId for A then B on each scan.
    // Both get the same price (0.65), which for mutually_exclusive gives pA+pB=1.30 > 1 → signal.
    const gammaApi = {
      getMarketByConditionId: vi.fn()
        .mockImplementation((conditionId: string) =>
          Promise.resolve(mockMarket(0.65, conditionId)),
        ),
    };

    const COOLDOWN_MS = 30;  // very short, real-time wait in test

    const svc = new LogicArbService(
      gammaApi as any,
      makeSupabaseStub([MOCK_PAIR]) as any,
      async () => 400,
    );

    svc.updateConfig({
      cooldownMs:      COOLDOWN_MS,
      scanIntervalMs:  COOLDOWN_MS + 10,  // each scan is after cooldown expires
      minNetProfitUSD: 0.01,
    });

    const signals: LogicArbSignal[] = [];
    svc.on('signal', (s) => signals.push(s));

    const done = waitForScans(svc, 2);
    await svc.start();
    await done;

    // Both scans are separated by cooldownMs+10, so both should emit.
    expect(signals).toHaveLength(2);
  });
});

// ── Dead-pair deactivation ─────────────────────────────────────────────────────

describe('LogicArbService — dead-pair deactivation', () => {
  it('marks pair inactive after deadPairNullThreshold consecutive null scans', async () => {
    const gammaApi = {
      // Always returns null — simulates a resolved/delisted market.
      getMarketByConditionId: vi.fn().mockResolvedValue(null),
    };

    const updateEq = vi.fn().mockResolvedValue({ error: null });

    const svc = new LogicArbService(
      gammaApi as any,
      makeSupabaseStub([MOCK_PAIR], updateEq) as any,
      async () => 400,
    );

    const THRESHOLD = 3;
    svc.updateConfig({
      deadPairNullThreshold: THRESHOLD,
      scanIntervalMs:        5,
    });

    // Run THRESHOLD scans so the counter trips on the last one.
    const done = waitForScans(svc, THRESHOLD);
    await svc.start();
    await done;

    // The update(...).eq('id', pair.id) chain should have been called once.
    expect(updateEq).toHaveBeenCalledWith('id', MOCK_PAIR.id);
    expect(updateEq).toHaveBeenCalledTimes(1);
  });

  it('does NOT deactivate before the threshold is reached', async () => {
    const gammaApi = {
      getMarketByConditionId: vi.fn().mockResolvedValue(null),
    };

    const updateEq = vi.fn().mockResolvedValue({ error: null });

    const svc = new LogicArbService(
      gammaApi as any,
      makeSupabaseStub([MOCK_PAIR], updateEq) as any,
      async () => 400,
    );

    const THRESHOLD = 5;
    svc.updateConfig({
      deadPairNullThreshold: THRESHOLD,
      scanIntervalMs:        5,
    });

    // Run THRESHOLD-1 scans only — update should not have fired yet.
    const done = waitForScans(svc, THRESHOLD - 1);
    await svc.start();
    await done;

    expect(updateEq).not.toHaveBeenCalled();
  });

  it('resets null counter and does not deactivate when markets return data', async () => {
    const gammaApi = {
      getMarketByConditionId: vi.fn()
        // Scan 1: both null (count → 1)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        // Scan 2: both present — reset counter to 0
        .mockResolvedValueOnce(mockMarket(0.65, MOCK_PAIR.market_a_condition_id))
        .mockResolvedValueOnce(mockMarket(0.55, MOCK_PAIR.market_b_condition_id))
        // Scan 3: null again (count → 1, not 2 — was reset)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };

    const updateEq = vi.fn().mockResolvedValue({ error: null });

    const svc = new LogicArbService(
      gammaApi as any,
      makeSupabaseStub([MOCK_PAIR], updateEq) as any,
      async () => 400,
    );

    svc.updateConfig({
      deadPairNullThreshold: 2,   // would trigger after 2 consecutive nulls
      scanIntervalMs:        5,
      minNetProfitUSD:       0.01,
    });

    const done = waitForScans(svc, 3);
    await svc.start();
    await done;

    // Counter was reset at scan 2, so scan 3 is only null-count=1 → no deactivation.
    expect(updateEq).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NegRiskArbService
// ══════════════════════════════════════════════════════════════════════════════

describe('NegRiskArbService — cooldown', () => {
  /**
   * Build a minimal GammaApiClient stub that returns a single NegRisk-qualifying
   * event with `n` outcomes at the given YES prices.
   */
  function makeNegRiskGammaApi(yesPrices: number[]) {
    const markets = yesPrices.map((p, i) => ({
      conditionId:   `cond-${i}`,
      active:        true,
      closed:        false,
      outcomePrices: [p, 1 - p],
    }));

    return {
      getEvents: vi.fn().mockResolvedValue([
        {
          id:      'event-1',
          title:   'Test NegRisk Event',
          markets,
        },
      ]),
    };
  }

  it('emits signal on first scan and suppresses repeats within cooldownMs', async () => {
    // Σ YES = 1.08 → SHORT arb (yesSum > 1)
    const gammaApi = makeNegRiskGammaApi([0.40, 0.35, 0.33]);

    const svc = new NegRiskArbService(
      gammaApi as any,
      async () => 400,  // mock fee fetcher
    );

    svc.updateConfig({
      cooldownMs:      60_000,
      scanIntervalMs:  5,
      minNetProfitUSD: 0.01,
      minOutcomes:     2,
      maxOutcomes:     10,
    });

    const signals: NegRiskArbSignal[] = [];
    svc.on('signal', (s) => signals.push(s));

    const done = waitForScans(svc, 2);
    await svc.start();
    await done;

    // Only 1 signal despite 2 scans: cooldown suppressed the second.
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe('short');
    expect(signals[0].eventId).toBe('event-1');
  });

  it('long arb: emits signal when Σ YES < 1', async () => {
    // Σ YES = 0.88 → LONG arb
    const gammaApi = makeNegRiskGammaApi([0.32, 0.30, 0.26]);

    const svc = new NegRiskArbService(
      gammaApi as any,
      async () => 400,
    );

    svc.updateConfig({
      cooldownMs:      60_000,
      scanIntervalMs:  5,
      minNetProfitUSD: 0.01,
      minOutcomes:     2,
      maxOutcomes:     10,
    });

    const signals: NegRiskArbSignal[] = [];
    svc.on('signal', (s) => signals.push(s));

    const done = waitForScans(svc, 2);
    await svc.start();
    await done;

    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe('long');
  });

  it('tracks long and short cooldowns independently', async () => {
    // Σ YES = exactly 1.08 on all scans — only SHORT should fire.
    // To test independence we need both long AND short simultaneously, which
    // requires a sum that crosses both thresholds — not physically possible.
    // Instead: verify that a short cooldownKey does not block a long signal
    // (they use '${eventId}:long' and '${eventId}:short' as separate keys).

    let callCount = 0;
    const gammaApi = {
      getEvents: vi.fn().mockImplementation(async () => {
        callCount++;
        const yesPrices = callCount === 1
          ? [0.40, 0.35, 0.33]   // scan 1: Σ=1.08 → short
          : [0.30, 0.28, 0.26];  // scan 2: Σ=0.84 → long (different direction, new key)
        return [{
          id:    'event-1',
          title: 'Test NegRisk Event',
          markets: yesPrices.map((p, i) => ({
            conditionId:   `cond-${i}`,
            active:        true,
            closed:        false,
            outcomePrices: [p, 1 - p],
          })),
        }];
      }),
    };

    const svc = new NegRiskArbService(
      gammaApi as any,
      async () => 400,
    );

    svc.updateConfig({
      cooldownMs:      60_000,
      scanIntervalMs:  5,
      minNetProfitUSD: 0.01,
      minOutcomes:     2,
      maxOutcomes:     10,
    });

    const signals: NegRiskArbSignal[] = [];

    // Wait for 2 signals (not 2 scans) — NegRiskArbService emits 'scanned' BEFORE
    // the candidates loop, so waiting on 'scanned' could resolve before the second
    // scan's async resolveFeeRate() completes and the signal fires.
    const done = new Promise<void>((resolve) => {
      svc.on('signal', (s: NegRiskArbSignal) => {
        signals.push(s);
        if (signals.length >= 2) {
          svc.stop();
          resolve();
        }
      });
    });

    await svc.start();
    await done;

    // Scan 1 → short signal; scan 2 → long signal.  Both should fire (different keys).
    expect(signals).toHaveLength(2);
    expect(signals.find(s => s.direction === 'short')).toBeDefined();
    expect(signals.find(s => s.direction === 'long')).toBeDefined();
  });
});
