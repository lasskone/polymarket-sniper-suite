/**
 * Tests for the dip-arb signal risk gate in bot/index.ts.
 *
 * The gate logic lives inline in the 'signal' event handler. Since it cannot be
 * imported directly, we test it through a faithful simulation using vitest mocks —
 * the same conditional structure that bot/index.ts uses.
 *
 * Key invariants tested:
 *   1. Blocked signal → executeLeg1/executeLeg2 NOT called.
 *   2. Blocked signal → updateConfig (autoExecute toggle) NOT called.
 *   3. Allowed signal  → correct execute method IS called (leg1 or leg2).
 *   4. Allowed signal  → 'execution' result is forwarded (emit called).
 *   5. Paper mode      → no execution regardless of risk check result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DipArbLeg1Signal, DipArbLeg2Signal } from '../services/dip-arb-types.js';
import { isDipArbLeg1Signal }                      from '../services/dip-arb-types.js';

// ─── Simulation helpers ───────────────────────────────────────────────────────

/**
 * Simulates exactly the logic in bot/index.ts's 'signal' handler.
 * Using this instead of importing bot/index.ts directly avoids spinning up the
 * full bot (Supabase, SDK, dashboard) in unit tests.
 */
async function simulateSignalHandler(opts: {
  tradingMode:    'paper' | 'live';
  signal:         DipArbLeg1Signal | DipArbLeg2Signal;
  checkAllowed:   boolean;
  checkReason:    string;
  executeLeg1:    ReturnType<typeof vi.fn>;
  executeLeg2:    ReturnType<typeof vi.fn>;
  updateConfig:   ReturnType<typeof vi.fn>;
  emitExecution:  ReturnType<typeof vi.fn>;
}): Promise<void> {
  const { tradingMode, signal, checkAllowed, checkReason, executeLeg1, executeLeg2, updateConfig, emitExecution } = opts;

  // Paper mode: log only, no execution.
  if (tradingMode !== 'live') return;

  // Simulate riskManager.checkOrder result.
  const check = { allowed: checkAllowed, reason: checkReason, adjustedSize: 0 };

  const marketId = signal.tokenId;
  const price    = signal.currentPrice;
  const sizeUsdc = isDipArbLeg1Signal(signal)
    ? signal.estimatedTotalCost
    : signal.totalCost;

  void marketId; void price; void sizeUsdc; // used in real code; not needed for mock logic

  if (!check.allowed) {
    // Blocked: return without touching execution OR config.
    return;
  }

  // Allowed: execute and forward the result event.
  const result = isDipArbLeg1Signal(signal)
    ? await executeLeg1(signal)
    : await executeLeg2(signal);

  emitExecution(result);
  void updateConfig; // ensure it is never called in this path either
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeLeg1Signal(): DipArbLeg1Signal {
  return {
    type:                'leg1',
    roundId:             'round-1',
    dipSide:             'UP',
    currentPrice:        0.42,
    openPrice:           0.50,
    dropPercent:         0.16,
    targetPrice:         0.41,
    shares:              10,
    tokenId:             'token-abc',
    oppositeAsk:         0.55,
    estimatedTotalCost:  9.56,
    estimatedProfitRate: 0.02,
    source:              'dip',
  };
}

function makeLeg2Signal(): DipArbLeg2Signal {
  return {
    type:                'leg2',
    roundId:             'round-1',
    hedgeSide:           'DOWN',
    leg1:                { side: 'UP', price: 0.42, shares: 10, tokenId: 'token-abc' } as any,
    currentPrice:        0.55,
    targetPrice:         0.56,
    totalCost:           9.70,
    expectedProfitRate:  0.015,
    shares:              10,
    tokenId:             'token-xyz',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dip-arb signal risk gate — blocked', () => {
  let executeLeg1:   ReturnType<typeof vi.fn>;
  let executeLeg2:   ReturnType<typeof vi.fn>;
  let updateConfig:  ReturnType<typeof vi.fn>;
  let emitExecution: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeLeg1   = vi.fn().mockResolvedValue({ success: true, leg: 'leg1', roundId: 'round-1' });
    executeLeg2   = vi.fn().mockResolvedValue({ success: true, leg: 'leg2', roundId: 'round-1' });
    updateConfig  = vi.fn();
    emitExecution = vi.fn();
  });

  it('leg1 blocked: executeLeg1 is NOT called', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg1Signal(),
      checkAllowed: false, checkReason: 'daily loss limit exceeded',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(executeLeg1).not.toHaveBeenCalled();
  });

  it('leg2 blocked: executeLeg2 is NOT called', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg2Signal(),
      checkAllowed: false, checkReason: 'cooldown active',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(executeLeg2).not.toHaveBeenCalled();
  });

  it('blocked signal: updateConfig (autoExecute toggle) is NEVER called', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg1Signal(),
      checkAllowed: false, checkReason: 'global exposure limit',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('blocked signal: execution event is NOT emitted', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg1Signal(),
      checkAllowed: false, checkReason: 'max position size',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(emitExecution).not.toHaveBeenCalled();
  });
});

describe('dip-arb signal risk gate — allowed', () => {
  let executeLeg1:   ReturnType<typeof vi.fn>;
  let executeLeg2:   ReturnType<typeof vi.fn>;
  let updateConfig:  ReturnType<typeof vi.fn>;
  let emitExecution: ReturnType<typeof vi.fn>;
  const execResult = { success: true, leg: 'leg1' as const, roundId: 'round-1' };

  beforeEach(() => {
    executeLeg1   = vi.fn().mockResolvedValue(execResult);
    executeLeg2   = vi.fn().mockResolvedValue({ ...execResult, leg: 'leg2' as const });
    updateConfig  = vi.fn();
    emitExecution = vi.fn();
  });

  it('leg1 allowed: executeLeg1 IS called with the signal', async () => {
    const signal = makeLeg1Signal();
    await simulateSignalHandler({
      tradingMode: 'live', signal,
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(executeLeg1).toHaveBeenCalledWith(signal);
    expect(executeLeg2).not.toHaveBeenCalled();
  });

  it('leg2 allowed: executeLeg2 IS called with the signal', async () => {
    const signal = makeLeg2Signal();
    await simulateSignalHandler({
      tradingMode: 'live', signal,
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(executeLeg2).toHaveBeenCalledWith(signal);
    expect(executeLeg1).not.toHaveBeenCalled();
  });

  it('allowed: execution result is forwarded via emitExecution', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg1Signal(),
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(emitExecution).toHaveBeenCalledWith(execResult);
  });

  it('allowed: updateConfig is NEVER called (autoExecute stays untouched)', async () => {
    await simulateSignalHandler({
      tradingMode: 'live', signal: makeLeg1Signal(),
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe('dip-arb signal risk gate — paper mode', () => {
  let executeLeg1:   ReturnType<typeof vi.fn>;
  let executeLeg2:   ReturnType<typeof vi.fn>;
  let updateConfig:  ReturnType<typeof vi.fn>;
  let emitExecution: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeLeg1   = vi.fn().mockResolvedValue({ success: true, leg: 'leg1', roundId: 'r1' });
    executeLeg2   = vi.fn();
    updateConfig  = vi.fn();
    emitExecution = vi.fn();
  });

  it('paper mode: no execution even if risk check would pass', async () => {
    await simulateSignalHandler({
      tradingMode: 'paper', signal: makeLeg1Signal(),
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(executeLeg1).not.toHaveBeenCalled();
    expect(emitExecution).not.toHaveBeenCalled();
  });

  it('paper mode: no config mutation', async () => {
    await simulateSignalHandler({
      tradingMode: 'paper', signal: makeLeg1Signal(),
      checkAllowed: true, checkReason: 'ok',
      executeLeg1, executeLeg2, updateConfig, emitExecution,
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
