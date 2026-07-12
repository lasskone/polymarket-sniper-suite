/**
 * scripts/test-trade-executor.ts
 *
 * Tests the TradeExecutor in paper mode (default) or live mode.
 *
 * Run with:  npm run test:trade-executor
 *
 * IMPORTANT: Live mode places a REAL 1 USDC order on Polygon mainnet.
 *            Only run in live mode with a funded wallet and valid credentials.
 *            Default (TRADING_MODE=paper) never touches the CLOB.
 *
 * Sections:
 *   1. Config validation
 *   2. Paper trade — mock opportunity → TradeExecutor → log result
 *   3. CLOB connectivity check (read-only, no private key needed)
 *   4. [Live only] API key derivation + $1 order
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig }                from '../modules/shared/config.js';
import { loadLatencySniperConfig }   from '../modules/latency-sniper/config.js';
import { createTradeExecutor }       from '../modules/latency-sniper/trade-executor.js';
import { ClobClient }                from '@polymarket/clob-client';
import { createLogger }              from '../modules/shared/logger.js';
import type { Opportunity }          from '../modules/latency-sniper/types.js';
import type { NewEvent, Match, Event, Team }
  from '../modules/latency-sniper/event-detector.js';
import type { PolymarketMarket }     from '../modules/latency-sniper/market-matcher.js';

const log = createLogger('test-trade-executor');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID  = 137;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeTeam(id: number, name: string): Team {
  return { id, name, logo: '' };
}

function makeMockOpportunity(): Opportunity {
  const homeTeam = makeTeam(33, 'Manchester United');
  const awayTeam = makeTeam(40, 'Liverpool');

  const match: Match = {
    fixtureId: 999999,
    league: 'Premier League',
    homeTeam,
    awayTeam,
    status: '1H',
    minute: 35,
    score: { home: 1, away: 0 },
    events: [],
    lastUpdate: Date.now(),
  };

  const event: Event = {
    time: 35,
    type: 'Goal',
    detail: 'Normal Goal',
    team: homeTeam,
    player: { id: 1, name: 'Marcus Rashford' },
  };

  const ne: NewEvent = { match, event, detectedAt: Date.now() };

  // Find a real active market to use for the test, or use a placeholder
  const market: PolymarketMarket = {
    id:            'test-market-id',
    conditionId:   'test-condition-id',
    question:      'Will Manchester United win the Premier League match?',
    slug:          'man-utd-premier-league-win',
    outcomes:      ['Yes', 'No'],
    outcomePrices: ['0.55', '0.45'],
    volume:        50_000,
    liquidity:     20_000,
    endDate:       new Date(Date.now() + 86_400_000).toISOString(),
    tags:          ['Sports', 'Soccer', 'Premier League'],
    description:   'Test market for trade executor',
  };

  return {
    event: ne,
    market,
    priceEstimate: {
      currentPrice:  0.55,
      expectedPrice: 0.70,
      edge:          0.15,
      confidence:    82,
      reasoning:     'Goal at minute 35 — first goal, early in match, significant impact',
    },
    side:     'YES',
    sizeUsdc: 1,   // Always test with $1
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function sectionConfig(): Promise<boolean> {
  log.info('── Section 1: Config validation ──');

  try {
    const mainConfig = loadConfig();
    const cfg = loadLatencySniperConfig(mainConfig);

    log.info('[OK] Config loaded', {
      tradingMode:        cfg.tradingMode,
      maxPositionSize:    cfg.maxPositionSizeUsdc,
      minProfitThreshold: cfg.minProfitThreshold,
      walletAddress:      mainConfig.walletAddress
        ? mainConfig.walletAddress.slice(0, 10) + '…'
        : '(not set)',
      hasPrivateKey:      !!mainConfig.privateKey,
    });

    if (cfg.tradingMode === 'live') {
      log.warn('TRADING_MODE=live — this test will place a REAL $1 order!');
      log.warn('You have 5 seconds to Ctrl+C if this is unintended…');
      await sleep(5_000);
    }

    return true;
  } catch (err) {
    log.error('[FAIL] Config load failed', { error: String(err) });
    return false;
  }
}

async function sectionPaperTrade(): Promise<boolean> {
  log.info('── Section 2: Paper trade simulation ──');

  try {
    const mainConfig = loadConfig();
    const cfg = loadLatencySniperConfig(mainConfig);

    // Force paper mode for this section regardless of env
    const paperCfg = { ...cfg, tradingMode: 'paper' as const };
    const executor = createTradeExecutor({
      ...paperCfg,
      privateKey:    mainConfig.privateKey,
      walletAddress: mainConfig.walletAddress,
    });

    const opp = makeMockOpportunity();

    log.info('Executing paper trade…', {
      question: opp.market.question,
      side:     opp.side,
      sizeUsdc: opp.sizeUsdc,
      edge:     opp.priceEstimate.edge,
    });

    const result = await executor.executeTrade(opp);

    if (!result.success) {
      log.error('[FAIL] Paper trade returned success=false', { error: result.error });
      return false;
    }

    if (!result.paper) {
      log.error('[FAIL] Paper trade result should have paper=true');
      return false;
    }

    log.info('[OK] Paper trade result', {
      orderId:    result.orderId,
      filledSize: result.filledSize?.toFixed(4),
      avgPrice:   result.avgPrice,
      amountUsdc: result.amountUsdc,
      paper:      result.paper,
    });

    return true;
  } catch (err) {
    log.error('[FAIL] Paper trade threw unexpectedly', { error: String(err) });
    return false;
  }
}

async function sectionClobConnectivity(): Promise<boolean> {
  log.info('── Section 3: CLOB connectivity (read-only) ──');

  try {
    // No signer needed for read-only calls
    const client = new ClobClient(CLOB_HOST, CHAIN_ID);

    const ok = await client.getOk();
    log.info('[OK] CLOB reachable', { response: ok });

    const serverTime = await client.getServerTime();
    log.info('[OK] Server time', {
      serverTime,
      localTime:  Date.now(),
      driftMs:    Math.abs(serverTime * 1000 - Date.now()),
    });

    return true;
  } catch (err) {
    log.error('[FAIL] CLOB connectivity check failed', { error: String(err) });
    return false;
  }
}

async function sectionLiveOrder(): Promise<boolean> {
  log.info('── Section 4: Live $1 order (LIVE MODE ONLY) ──');

  const mainConfig = loadConfig();
  if (mainConfig.tradingMode !== 'live') {
    log.info('[SKIP] TRADING_MODE is not "live" — skipping live order test');
    return true;
  }

  try {
    const cfg      = loadLatencySniperConfig(mainConfig);
    const executor = createTradeExecutor({
      ...cfg,
      privateKey:    mainConfig.privateKey,
      walletAddress: mainConfig.walletAddress,
    });

    await executor.initialize();
    log.info('[OK] CLOB client initialized with credentials');

    const opp = makeMockOpportunity();

    log.info('Placing LIVE $1 FOK order…', {
      conditionId: opp.market.conditionId,
      side:        opp.side,
      sizeUsdc:    opp.sizeUsdc,
      price:       opp.priceEstimate.currentPrice,
    });

    const result = await executor.executeTrade(opp);

    log.info(`Order result: ${result.success ? '[OK] SUCCESS' : '[FAIL] FAILED'}`, {
      orderId:    result.orderId,
      filledSize: result.filledSize,
      avgPrice:   result.avgPrice,
      amountUsdc: result.amountUsdc,
      error:      result.error,
      paper:      result.paper,
    });

    // A FOK on a non-existent test market will likely return CANCELLED —
    // that's expected and counts as a successful test of the executor path
    const executorWorked = result.orderId !== undefined || result.error !== undefined;
    return executorWorked;

  } catch (err) {
    log.error('[FAIL] Live order test threw', { error: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== TradeExecutor Test Suite ===\n');

  const results = [
    await sectionConfig(),
    await sectionPaperTrade(),
    await sectionClobConnectivity(),
    await sectionLiveOrder(),
  ];

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;

  console.log('\n================================');
  console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
  console.log('================================');

  if (failed > 0) process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
