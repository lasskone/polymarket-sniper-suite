/**
 * scripts/test-risk-manager.ts
 *
 * Integration test for the RiskManager.
 * Requires a live Supabase connection with the schema applied.
 *
 * Run with:  npm run test:risk
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getSupabaseClient } from '../modules/shared/supabase-client.js';
import { createRiskManager, type RiskConfig } from '../modules/shared/risk-manager.js';
import { createLogger } from '../modules/shared/logger.js';

const log = createLogger('test-risk-manager');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestCase {
  name: string;
  module: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  sizeUsdc: number;
  price: number;
  expectAllowed: boolean | 'any';  // 'any' = don't assert
  expectSizeReduced?: boolean;
}

async function runTest(
  rm: ReturnType<typeof createRiskManager>,
  tc: TestCase,
): Promise<boolean> {
  const result = await rm.checkOrder(tc.module, tc.marketId, tc.side, tc.sizeUsdc, tc.price);

  const allowedMatch =
    tc.expectAllowed === 'any' || result.allowed === tc.expectAllowed;

  const sizeMatch =
    tc.expectSizeReduced === undefined ||
    (tc.expectSizeReduced ? result.adjustedSize < tc.sizeUsdc : result.adjustedSize === tc.sizeUsdc);

  const passed = allowedMatch && sizeMatch;

  const status = passed ? '[PASS]' : '[FAIL]';
  log.info(`${status} ${tc.name}`, {
    allowed: result.allowed,
    adjustedSize: result.adjustedSize,
    reason: result.reason,
    expectAllowed: tc.expectAllowed,
  });

  if (!passed) {
    log.error(`  Expected allowed=${tc.expectAllowed}, got allowed=${result.allowed}`, {
      adjustedSize: result.adjustedSize,
      reason: result.reason,
    });
  }

  return passed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RiskManager Test Suite ===\n');

  // ── Supabase ──────────────────────────────────────────────────────────────
  let supabase: ReturnType<typeof getSupabaseClient>;
  try {
    supabase = getSupabaseClient();
    log.info('Supabase client initialised');
  } catch (err) {
    log.error('Failed to initialise Supabase client', { error: String(err) });
    log.error('Have you set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env?');
    process.exit(1);
  }

  // ── Config ────────────────────────────────────────────────────────────────
  const riskConfig: RiskConfig = {
    maxPositionSizeUsdc: 100,
    maxPositionPercentage: 2,
    minPositionSizeUsdc: 10,
    dailyLossLimitUsdc: 50,
    maxExposurePerMarketUsdc: 500,
    maxGlobalExposureUsdc: 2000,
    cooldownMinutes: 30,
    consecutiveLossesBeforeCooldown: 3,
  };

  const rm = createRiskManager(riskConfig, supabase);

  // ── Test cases ────────────────────────────────────────────────────────────
  const tests: TestCase[] = [
    {
      name: 'Normal trade within all limits',
      module: 'latency-sniper',
      marketId: 'test-market-normal',
      side: 'BUY',
      sizeUsdc: 50,
      price: 0.6,
      expectAllowed: true,
      expectSizeReduced: false,
    },
    {
      name: 'Trade exceeding max position size — size should be reduced',
      module: 'latency-sniper',
      marketId: 'test-market-oversize',
      side: 'BUY',
      sizeUsdc: 250,   // > maxPositionSizeUsdc (100)
      price: 0.5,
      expectAllowed: true,
      expectSizeReduced: true,
    },
    {
      name: 'Trade below minimum position size — should be blocked',
      module: 'resolution-arb',
      marketId: 'test-market-tiny',
      side: 'BUY',
      sizeUsdc: 5,     // < minPositionSizeUsdc (10)
      price: 0.9,
      expectAllowed: false,
    },
    {
      name: 'Trade would breach per-market exposure limit',
      module: 'latency-sniper',
      marketId: 'test-market-exposure',
      side: 'BUY',
      // We query live Supabase — on a clean DB today's exposure is 0, so
      // 600 USDC alone would exceed the 500 USDC per-market cap.
      sizeUsdc: 600,
      price: 0.5,
      expectAllowed: false,
    },
    {
      name: 'Trade would breach global exposure limit',
      module: 'cross-market-arb',
      marketId: 'test-market-global',
      side: 'BUY',
      // 2500 USDC alone exceeds the 2000 USDC global cap.
      sizeUsdc: 2500,
      price: 0.5,
      expectAllowed: false,
    },
    {
      name: 'Normal sell trade',
      module: 'market-making',
      marketId: 'test-market-sell',
      side: 'SELL',
      sizeUsdc: 30,
      price: 0.55,
      expectAllowed: true,
      expectSizeReduced: false,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of tests) {
    const ok = await runTest(rm, tc);
    if (ok) passed++; else failed++;
  }

  // ── Consecutive loss cooldown ─────────────────────────────────────────────
  console.log('\n--- Consecutive loss cooldown test ---');
  const cooldownRm = createRiskManager(
    { ...riskConfig, consecutiveLossesBeforeCooldown: 3, cooldownMinutes: 1 },
    supabase,
  );

  // Record 3 losses
  for (let i = 0; i < 3; i++) {
    await cooldownRm.recordPnl('latency-sniper', 'cooldown-test-market', -5);
  }

  const afterCooldown = await cooldownRm.checkOrder(
    'latency-sniper', 'cooldown-test-market', 'BUY', 20, 0.5,
  );

  const cooldownBlocked = !afterCooldown.allowed && afterCooldown.reason.includes('Cooldown');
  log.info(`${cooldownBlocked ? '[PASS]' : '[FAIL]'} Cooldown after 3 consecutive losses`, {
    allowed: afterCooldown.allowed,
    reason: afterCooldown.reason,
  });
  if (cooldownBlocked) passed++; else failed++;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n================================');
  console.log(`  PASSED: ${passed}  FAILED: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
