/**
 * bot/index.ts — Polymarket Sniper Suite main entry point.
 *
 * Compile:  npm run build        → dist/bot/index.js
 * Run:      npm start            → node dist/bot/index.js
 * Dev:      npm run dev          → tsx bot/index.ts
 *
 * NOTE: src/index.ts is the SDK barrel; this file is the bot orchestrator.
 *
 * Startup sequence:
 *   1. Register uncaughtException / unhandledRejection handlers
 *   2. Start dashboard server immediately (sync, binds to 0.0.0.0)
 *   3. Load + validate config (fatal on error)
 *   4. Verify Supabase connection (non-fatal warning if unavailable)
 *   5. Initialize shared services (RiskManager)
 *   6. Start enabled modules concurrently via Promise.allSettled()
 *   7. Periodic status log every 5 minutes
 *   8. Graceful shutdown on SIGTERM / SIGINT
 *
 * The health server is started at step 2 — BEFORE any async work — so
 * Railway's health check passes during startup even if Supabase or a
 * module takes time to initialise.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig }                from '../modules/shared/config.js';
import { createLogger }              from '../modules/shared/logger.js';
import { getSupabaseClient,
         verifySupabaseConnection }  from '../modules/shared/supabase-client.js';
import { createRiskManager }         from '../modules/shared/risk-manager.js';
import { runLatencySniper }          from '../modules/latency-sniper/index.js';
import { runResolutionArb }          from '../modules/resolution-arb/index.js';
import { runCrossMarketArb }         from '../modules/cross-market-arb/index.js';
import {
  startDashboard,
  stopDashboard,
  dashboardEmitter,
} from '../src/dashboard/index.js';
import type { BotState, BotConfig } from '../src/dashboard/index.js';
import { PolymarketSDK }             from '../src/index.js';
import type { DipArbUnderlying, DipArbSignal } from '../src/services/dip-arb-types.js';
import {
  isDipArbLeg1Signal,
  isDipArbLeg2Signal,
  resolveEffectiveSumTarget,
  netProfitAfterFees as dipArbNetProfitAfterFees,
}                                    from '../src/services/dip-arb-types.js';
import { LogicArbService }           from '../src/services/logic-arb-service.js';
import type { LogicArbConfig }       from '../src/services/logic-arb-types.js';
import type { LogicArbSignal }       from '../src/services/logic-arb-types.js';
import { computeShares }             from '../src/services/dip-arb-sizing.js';
import { SportsbookArbService }      from '../src/services/sportsbook-arb-service.js';
import type { SportsbookArbSignal, SportsbookArbScanResult } from '../src/services/sportsbook-arb-types.js';
import { runPaperTradeResolver }     from '../src/services/paper-trade-resolver.js';
import { PairDiscoveryService }      from '../src/services/pair-discovery-service.js';

// ---------------------------------------------------------------------------
// Step 1: Error handlers — registered before anything else so no exception
//         can silently kill the process (and take the health server with it).
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  dashboardEmitter.log('ERROR', `Uncaught Exception: ${String(err)}`);
  // Don't exit — keep the bot running
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  dashboardEmitter.log('ERROR', `Unhandled Rejection: ${String(reason)}`);
});

// ---------------------------------------------------------------------------
// Step 2: Start health server IMMEDIATELY — synchronous call, no awaiting.
//         Railway health checks begin as soon as the container starts, so
//         this must happen before any async I/O (Supabase, APIs, etc.).
// ---------------------------------------------------------------------------

// Version banner — updated on each deploy to bust the nixpacks build cache and
// confirm which commit is active in Railway logs.
console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', source: 'main', message: 'Bot starting', version: '7f33511+' }));

const PORT = parseInt(process.env.PORT || '8080', 10);
console.log(`Starting dashboard server on port ${PORT}`);
startDashboard(PORT);
// "Dashboard server ready" is logged inside startDashboard's listen callback.

// ---------------------------------------------------------------------------
// Logger — initialised after health server so it can't block step 2.
// ---------------------------------------------------------------------------

const log = createLogger('main');

// Latest OddsPapi request stats from the sportsbook-arb module — updated on each
// 'scanned' event and included in the heartbeat log.
let sbArbRequestStats: {
	today: number;
	month: number;
	quota: number;
	nearCeiling: boolean;
} | null = null;

// ---------------------------------------------------------------------------
// Shutdown coordination
// ---------------------------------------------------------------------------

let shuttingDown    = false;
const SHUTDOWN_GRACE_MS = 10_000;

function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal} — shutting down`, { graceMs: SHUTDOWN_GRACE_MS });

  const timer = setTimeout(() => {
    log.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  timer.unref();

  stopDashboard()
    .then(() => {
      log.info('Dashboard server stopped. Goodbye.');
      process.exit(0);
    })
    .catch(() => process.exit(1));
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT',  () => requestShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Module runner — wraps a module so crashes restart it after a delay
// ---------------------------------------------------------------------------

async function runWithRestart(
  name: string,
  fn: () => Promise<void>,
  restartDelayMs = 30_000,
): Promise<void> {
  while (!shuttingDown) {
    try {
      log.info(`Module starting`, { module: name });
      await fn();
      // If fn() returns normally (stub module), exit loop — don't spin forever
      log.info(`Module exited cleanly`, { module: name });
      return;
    } catch (err) {
      dashboardEmitter.log('ERROR', `Module ${name} crashed: ${String(err)}`);
      log.error(`Module crashed — restarting in ${restartDelayMs / 1000}s`, {
        module: name,
        error:  String(err),
      });
      await sleep(restartDelayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic status reporter
// ---------------------------------------------------------------------------

function startStatusReporter(activeModules: string[]): NodeJS.Timeout {
  const INTERVAL_MS = 5 * 60_000;   // 5 minutes

  return setInterval(() => {
    const uptimeSec = Math.floor(process.uptime());
    const mem       = process.memoryUsage();

    log.info('Bot status heartbeat', {
      uptimeSec,
      uptimeHuman:  formatUptime(uptimeSec),
      activeModules,
      tradingMode:  loadConfig().tradingMode,
      memMb: {
        rss:      (mem.rss / 1_048_576).toFixed(1),
        heapUsed: (mem.heapUsed / 1_048_576).toFixed(1),
      },
      ...(sbArbRequestStats != null && {
        oddspapi: {
          requestsToday:     sbArbRequestStats.today,
          requestsThisMonth: sbArbRequestStats.month,
          monthlyQuota:      sbArbRequestStats.quota,
          pctUsed:           ((sbArbRequestStats.month / sbArbRequestStats.quota) * 100).toFixed(1) + '%',
          nearCeiling:       sbArbRequestStats.nearCeiling,
        },
      }),
    });
  }, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Main — all async work lives here; health server is already running above.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 3. Load config ────────────────────────────────────────────────────────
  console.log('Loading config...');
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('[FATAL] Config failed to load:', String(err));
    process.exit(1);
  }
  console.log('Config loaded');

  log.info('Starting polymarket-sniper-suite', {
    version:     '0.4.3',
    tradingMode: cfg.tradingMode,
    nodeEnv:     process.env.NODE_ENV ?? 'development',
    modules: {
      latencySniper:  cfg.enableLatencySniper,
      resolutionArb:  cfg.enableResolutionArb,
      crossMarketArb: cfg.enableCrossMarketArb,
      marketMaking:   cfg.enableMarketMaking,
    },
  });

  // ── 4. Supabase connection (non-fatal) ────────────────────────────────────
  console.log('Connecting to Supabase...');
  const supabase = getSupabaseClient();
  try {
    await verifySupabaseConnection();
    console.log('Supabase connected');
    log.info('Supabase connection verified');
  } catch (err) {
    console.warn('Supabase connection failed — trades will not be persisted');
    log.warn('Supabase connection failed — trades will not be persisted', {
      error: String(err),
    });
    // Continue — bot can still run in paper mode without Supabase
  }

  // ── 5. Shared services ────────────────────────────────────────────────────
  const riskManager = createRiskManager(
    {
      maxPositionSizeUsdc:      cfg.maxPositionSizeUsdc,
      maxPositionPercentage:    cfg.maxPositionPercentage,
      minPositionSizeUsdc:      cfg.minPositionSizeUsdc,
      dailyLossLimitUsdc:       cfg.dailyLossLimitUsdc,
      maxExposurePerMarketUsdc: cfg.maxExposurePerMarketUsdc,
      maxGlobalExposureUsdc:    cfg.maxGlobalExposureUsdc,
      cooldownMinutes:          cfg.cooldownMinutes,
    },
    supabase,
  );

  // ── 6. Resolve enabled / disabled modules ─────────────────────────────────
  const activeModules:   string[] = [];
  const disabledModules: string[] = [];

  const moduleDefinitions: Array<{ name: string; enabled: boolean; run: () => Promise<void> }> = [
    {
      name:    'latency-sniper',
      enabled: cfg.enableLatencySniper,
      run:     runLatencySniper,
    },
    {
      name:    'resolution-arb',
      enabled: cfg.enableResolutionArb,
      run:     runResolutionArb,
    },
    {
      name:    'cross-market-arb',
      enabled: cfg.enableCrossMarketArb,
      run:     runCrossMarketArb,
    },
    {
      name:    'dip-arb',
      enabled: process.env.ENABLE_DIP_ARB === 'true',
      run:     async (): Promise<void> => {
        const sdk = await PolymarketSDK.create({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY,
        });

        // Per-coin sumTarget config — mirrors sumTargetPerCoin used throughout the service.
        // resolveEffectiveSumTarget() picks the coin-specific value (falling back to sumTarget).
        const DIP_ARB_COIN_CONFIG = {
          sumTarget:        0.97,
          sumTargetPerCoin: { BTC: 0.97, ETH: 0.97, SOL: 0.96 } as Partial<Record<DipArbUnderlying, number>>,
        };

        // Tracks the underlying asset currently being monitored.
        // Updated by the 'started' event (fires on initial start AND on every auto-rotate).
        let currentCoin: DipArbUnderlying = 'ETH';

        // Fetch current USDC balance and compute dynamic share count for the given coin.
        async function resolveShares(coin: DipArbUnderlying): Promise<number> {
          const effectiveSumTarget = resolveEffectiveSumTarget(DIP_ARB_COIN_CONFIG, coin);
          try {
            const { balance } = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
            const balanceUsdc = parseFloat(balance);
            const shares = computeShares(
              balanceUsdc,
              cfg.positionSizePct,
              cfg.maxPositionSizeUsdc,
              effectiveSumTarget,
            );
            dashboardEmitter.log(
              'INFO',
              `DipArb sizing [${coin}]: balance=$${balanceUsdc.toFixed(2)} ` +
              `→ ${cfg.positionSizePct}% / sumTarget=${effectiveSumTarget} → shares=${shares}`,
            );
            return shares;
          } catch (err) {
            dashboardEmitter.log('WARN', `DipArb sizing: balance fetch failed, using 1 share (${String(err)})`);
            return 1;
          }
        }

        const initialShares = await resolveShares('ETH');

        // Mirror CONFIG.dipArb from bot-with-dashboard.ts (sumTargetPerCoin + minNetProfitUSD included).
        //
        // autoExecute is intentionally always false here. bot/index.ts takes over execution
        // responsibility in the 'signal' handler (after a riskManager gate in live mode).
        // This avoids a race condition where DipArbService would execute synchronously before
        // an async risk check in the signal listener could complete.
        sdk.dipArb.updateConfig({
          shares:           initialShares,
          sumTarget:        DIP_ARB_COIN_CONFIG.sumTarget,
          sumTargetPerCoin: DIP_ARB_COIN_CONFIG.sumTargetPerCoin,
          minNetProfitUSD:  0.05,
          autoExecute:      false,  // bot/index.ts manages execution via manual executeLeg1/2 calls
          debug:            false,
        });

        // Wire DipArbService events → dashboardEmitter so DipArbPanel receives live data.
        // 'started' fires both on initial start and on every auto-rotate, so we use it
        // to keep currentCoin in sync without needing a separate rotate handler for it.
        sdk.dipArb.on('started', (market: any) => {
          if (market.underlying) currentCoin = market.underlying as DipArbUnderlying;
          dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
          dashboardEmitter.log('INFO', `DipArb started: ${market.name} [${currentCoin}]`);
        });

        sdk.dipArb.on('orderbookUpdate', (update: { upPrice: number; downPrice: number; sum: number }) => {
          const s = dashboardEmitter.getState();
          if (s) {
            s.dipArb.upPrice   = update.upPrice;
            s.dipArb.downPrice = update.downPrice;
            s.dipArb.sum       = update.sum;
            dashboardEmitter.updateState(s);
          }
        });

        // autoExecute is always false — this handler drives all execution.
        //
        // Why manual execution instead of autoExecute: true?
        // DipArbService emits 'signal' synchronously inside handleSignal(), then immediately
        // calls executeLeg1/2 — before our async listener can complete a risk check.
        // With autoExecute: false the service stops after emitting the signal, giving this
        // handler full control over whether and when execution happens.
        //
        // In-process dedup: tracks which roundIds have already been recorded as paper trades
        // this run.  Belt-and-suspenders against any restart that might re-emit a round.
        const dipArbInsertedRounds = new Set<string>();

        sdk.dipArb.on('signal', async (signal: DipArbSignal) => {
          const side: string = isDipArbLeg1Signal(signal)
            ? signal.dipSide
            : signal.hedgeSide;
          dashboardEmitter.log(
            'SIGNAL',
            `DipArb ${signal.type}: ${side} @ ${signal.currentPrice.toFixed(3)}`,
          );

          // Record leg2 as a paper trade — leg2 represents the complete two-leg position.
          // leg1 alone is not a complete trade, so we skip it here.
          if (isDipArbLeg2Signal(signal)) {
            const netProfit = dipArbNetProfitAfterFees(
              signal.leg1.price,
              signal.currentPrice,
              signal.shares,
            );
            const label = `${signal.leg1.side}/${signal.hedgeSide} round ${signal.roundId}`;
            // In-process guard: each roundId is emitted exactly once per run, but a
            // hard restart could re-emit the same roundId if the leg2 event replays.
            if (!dipArbInsertedRounds.has(signal.roundId)) {
              dipArbInsertedRounds.add(signal.roundId);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (supabase as any).from('paper_trades').upsert({
                module:         'dip-arb',
                market_label:  label,
                net_profit_usd: netProfit,
                shares:         signal.shares,
                metadata:       signal as unknown as Record<string, unknown>,
                trading_mode:   cfg.tradingMode,
              }, { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true }).then(({ error }: { error: { message: string } | null }) => {
                if (error) {
                  dashboardEmitter.log('WARN', `DipArb paper trade insert failed: ${error.message}`);
                }
              });
            }
          }

          // Paper mode: log only, no execution.
          if (cfg.tradingMode !== 'live') return;

          // Live mode: gate through risk manager before executing.
          const marketId = signal.tokenId;
          const price    = signal.currentPrice;
          const sizeUsdc = isDipArbLeg1Signal(signal)
            ? signal.estimatedTotalCost
            : signal.totalCost;

          const check = await riskManager.checkOrder('dip-arb', marketId, 'BUY', sizeUsdc, price);
          if (!check.allowed) {
            dashboardEmitter.log('WARN', `DipArb risk gate blocked: ${check.reason}`);
            return;  // skip this signal — do not execute, do not mutate any config
          }

          // Risk check passed — execute manually and forward the result event.
          const result = isDipArbLeg1Signal(signal)
            ? await sdk.dipArb.executeLeg1(signal)
            : await sdk.dipArb.executeLeg2(signal);

          // In manual mode DipArbService does not emit 'execution'; we do it here so
          // the 'execution' listener below still fires for dashboard logging.
          sdk.dipArb.emit('execution', result);
        });

        sdk.dipArb.on('execution', (result: any) => {
          if (result.success) {
            dashboardEmitter.log(
              'TRADE',
              `DipArb ${result.leg}: ${result.side ?? ''} @ ${result.price?.toFixed(3) ?? '?'}`,
            );
          } else {
            dashboardEmitter.log('WARN', `DipArb execution failed (${result.leg}): ${result.error ?? 'unknown'}`);
          }
        });

        sdk.dipArb.on('roundComplete', async (result: any) => {
          const profitStr = result.profit != null ? ` | net $${result.profit.toFixed(4)}` : '';
          dashboardEmitter.log('INFO', `DipArb round ${result.roundId}: ${result.status}${profitStr}`);

          // Record realised P&L in the risk manager (updates daily loss tracker + Supabase).
          if (result.profit != null) {
            const marketId = result.marketId ?? result.conditionId ?? 'unknown';
            try {
              await riskManager.recordPnl('dip-arb', marketId, result.profit);
            } catch (err) {
              dashboardEmitter.log('WARN', `DipArb recordPnl failed: ${String(err)}`);
            }
          }
        });

        sdk.dipArb.on('rotate', async (event: any) => {
          dashboardEmitter.log('INFO', `DipArb rotated to new market (reason: ${event.reason})`);
          dashboardEmitter.updateStrategyStatus('dipArb', 'active');

          // Re-fetch balance and recompute shares for the new coin.
          // Note: 'started' fires before 'rotate' during auto-rotate, so currentCoin
          // is already updated to the new underlying by the time we reach here.
          const freshShares = await resolveShares(currentCoin);
          sdk.dipArb.updateConfig({ shares: freshShares });
        });

        sdk.dipArb.on('stopped', () => {
          dashboardEmitter.updateStrategyStatus('dipArb', 'idle');
        });

        sdk.dipArb.on('error', (err: Error) => {
          dashboardEmitter.log('ERROR', `DipArb error: ${err.message}`);
        });

        // Enable auto-rotate (matching bot-with-dashboard.ts)
        sdk.dipArb.enableAutoRotate({
          enabled:           true,
          underlyings:       ['ETH', 'BTC', 'SOL'] as DipArbUnderlying[],
          duration:          '15m',
          settleStrategy:    'redeem',
          redeemWaitMinutes: 5,
        });

        // Find and start monitoring a market
        const market = await sdk.dipArb.findAndStart({ coin: 'ETH', preferDuration: '15m' });
        if (market) {
          dashboardEmitter.log('INFO', `DipArb monitoring: ${market.name}`);
        } else {
          dashboardEmitter.log('WARN', 'DipArb: no suitable markets found — idling until restart');
          dashboardEmitter.updateStrategyStatus('dipArb', 'idle');
        }

        // Hold alive: DipArbService drives itself via WebSocket subscriptions.
        // Reject on the first unrecoverable error so runWithRestart resets the connection.
        try {
          await new Promise<never>((_, reject) => {
            sdk.dipArb.once('error', (err: Error) => reject(err));
          });
        } finally {
          await sdk.dipArb.stop();
        }
      },
    },
    {
      name:    'logic-arb',
      enabled: process.env.ENABLE_LOGIC_ARB === 'true',
      run:     async (): Promise<void> => {
        // Detection-only: reads correlated_market_pairs from Supabase,
        // fetches live prices via Gamma API, emits signals when mispricing
        // clears minNetProfitUSD after taker fees. No order execution.
        const sdk = await PolymarketSDK.create({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY,
        });

        const logicArb = new LogicArbService(sdk.gammaApi, supabase);

        // Read live config from bot_config table (module='logic-arb').
        // Falls back to service defaults if no rows exist.
        async function readLogicArbConfig(): Promise<Partial<LogicArbConfig>> {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data } = await (supabase as any)
              .from('bot_config')
              .select('key, value')
              .eq('module', 'logic-arb');
            if (!data?.length) return {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const kv = Object.fromEntries((data as any[]).map((r: any) => [r.key, r.value]));
            const cfg: Partial<LogicArbConfig> = {};
            if (kv['cooldown_ms'])                cfg.cooldownMs              = Number(kv['cooldown_ms']);
            if (kv['min_net_profit_usd'])         cfg.minNetProfitUSD         = Number(kv['min_net_profit_usd']);
            if (kv['dead_pair_null_threshold'])   cfg.deadPairNullThreshold   = Number(kv['dead_pair_null_threshold']);
            if (kv['dead_pair_closed_threshold']) cfg.deadPairClosedThreshold = Number(kv['dead_pair_closed_threshold']);
            return cfg;
          } catch {
            return {};
          }
        }

        // Apply initial overrides on top of service defaults, then hot-reload
        // every 2 minutes so dashboard config changes take effect without restart.
        logicArb.updateConfig({
          shares:          10,
          minNetProfitUSD: 0.05,
          scanIntervalMs:  60_000,
          ...(await readLogicArbConfig()),
        });

        logicArb.on('started', () => {
          dashboardEmitter.log('INFO', 'LogicArb scanner started');
          const cur = dashboardEmitter.getState();
          if (cur) dashboardEmitter.updateState({
            ...cur,
            logicArb: { ...cur.logicArb, status: 'scanning' },
          });
        });

        logicArb.on('scanned', (result: { pairsTotal: number; pairsScanned: number }) => {
          dashboardEmitter.log(
            'INFO',
            `LogicArb scanned ${result.pairsScanned}/${result.pairsTotal} pairs`,
          );
          const cur = dashboardEmitter.getState();
          if (cur) dashboardEmitter.updateState({
            ...cur,
            logicArb: {
              ...cur.logicArb,
              status:       'scanning',
              pairsTracked: result.pairsTotal,
              pairsScanned: result.pairsScanned,
            },
          });
        });

        logicArb.on('signal', (signal: LogicArbSignal) => {
          const rel = signal.relationship === 'a_implies_b'
            ? 'A→B'
            : 'MUTEX';
          dashboardEmitter.log(
            'SIGNAL',
            `LogicArb ${rel} — "${signal.marketASlug}" / "${signal.marketBSlug}" ` +
            `[pA=${signal.priceA.toFixed(4)}, pB=${signal.priceB.toFixed(4)}, ` +
            `dev=${signal.deviation.toFixed(4)}, net $${signal.netProfitUSD.toFixed(4)}] ` +
            `trade: ${signal.trade.legA.token}-A @ ${signal.trade.legA.price.toFixed(4)}, ` +
            `${signal.trade.legB.token}-B @ ${signal.trade.legB.price.toFixed(4)} ` +
            `(detection only)`,
          );

          // Record as paper trade (detection-only; always logged regardless of tradingMode).
          // upsert with ignoreDuplicates silently skips duplicate rows that match the
          // (module, market_label, date_trunc('minute', opened_at)) unique index.
          const label = `${signal.marketASlug} / ${signal.marketBSlug}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).from('paper_trades').upsert({
            module:         'logic-arb',
            market_label:  label,
            net_profit_usd: signal.netProfitUSD,
            shares:         signal.shares,
            metadata:       signal as unknown as Record<string, unknown>,
            trading_mode:   cfg.tradingMode,
          }, { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true }).then(({ error }: { error: { message: string } | null }) => {
            if (error) {
              dashboardEmitter.log('WARN', `LogicArb paper trade insert failed: ${error.message}`);
            }
          });

          const cur = dashboardEmitter.getState();
          if (cur) {
            const newSignal = {
              relationship:  signal.relationship,
              marketASlug:   signal.marketASlug,
              marketBSlug:   signal.marketBSlug,
              priceA:        signal.priceA,
              priceB:        signal.priceB,
              deviation:     signal.deviation,
              netProfitUSD:  signal.netProfitUSD,
              timestamp:     new Date().toISOString(),
            };
            const prev = cur.logicArb.recentSignals ?? [];
            dashboardEmitter.updateState({
              ...cur,
              logicArb: {
                ...cur.logicArb,
                lastSignal:    newSignal,
                recentSignals: [newSignal, ...prev].slice(0, 10),
              },
            });
          }
        });

        logicArb.on('feeRateFallback', (w: { conditionId: string; reason: string }) => {
          dashboardEmitter.log('WARN', `LogicArb fee fallback for ${w.conditionId}: ${w.reason}`);
        });

        logicArb.on('stopped', () => {
          dashboardEmitter.log('INFO', 'LogicArb scanner stopped');
          const cur = dashboardEmitter.getState();
          if (cur) dashboardEmitter.updateState({
            ...cur,
            logicArb: { ...cur.logicArb, status: 'idle' },
          });
        });

        logicArb.on('error', (err: Error) => {
          dashboardEmitter.log('ERROR', `LogicArb error: ${err.message}`);
        });

        await logicArb.start();

        // Poll bot_config every 2 min and hot-apply changes (no restart needed).
        const logicArbConfigTimer = setInterval(async () => {
          try {
            logicArb.updateConfig(await readLogicArbConfig());
          } catch { /* ignore poll errors */ }
        }, 2 * 60 * 1000);

        // Hold alive: LogicArbService drives itself via polling timer.
        // Reject on the first unrecoverable error so runWithRestart resets.
        try {
          await new Promise<never>((_, reject) => {
            logicArb.once('error', (err: Error) => reject(err));
          });
        } finally {
          clearInterval(logicArbConfigTimer);
          logicArb.stop();
        }
      },
    },
    {
      name:    'sportsbook-arb',
      enabled: process.env.ENABLE_SPORTSBOOK_ARB === 'true',
      run:     async (): Promise<void> => {
        // Detection-only: polls OddsPapi for Betfair Exchange (betfair-ex) odds,
        // fetches Polymarket prices directly from the Gamma API, matches fixtures
        // by normalised team name + date window, and emits 'signal' when the
        // Betfair mid-price fair probability exceeds the Polymarket price by
        // minEdge after fees.
        //
        // ⚠️  DIRECTIONAL BET — NOT RISK-FREE ARBITRAGE.
        // Signals represent expected-value opportunities; the underlying event
        // can resolve against us. Treat confidence < negRisk/logicArb bots.
        if (!cfg.oddspapiKey) {
          dashboardEmitter.log(
            'WARN',
            'SportsbookArb: ODDSPAPI_KEY not set — module disabled. ' +
            'Set ODDSPAPI_KEY in environment to enable.',
          );
          return;
        }

        const sbArb = new SportsbookArbService(cfg.oddspapiKey);
        sbArb.updateConfig({
          // Soccer only for now — NBA removed pending NBA Betfair Exchange coverage check.
          sportIds:                 [10],
          lookaheadDays:            3,
          liveStatusIds:            [2, 3, 4, 5, 6],
          fixtureRefreshIntervalMs: 3 * 60 * 60 * 1000,
          liveOddsIntervalMs:       60_000,
          pregameOddsIntervalMs:    30 * 60_000,
          pregameWindowMs:          24 * 60 * 60 * 1000,
          monthlyQuota:             parseInt(process.env.ODDSPAPI_MONTHLY_QUOTA ?? '3000', 10),
          quotaWarningThreshold:    0.9,
          minEdge:                  0.05,
          minNetProfitUSD:          0.05,
          shares:                   10,
        });

        sbArb.on('started', () => {
          dashboardEmitter.log('INFO', 'SportsbookArb scanner started (detection-only — directional bets)');
          const cur = dashboardEmitter.getState();
          if (cur) dashboardEmitter.updateState({
            ...cur,
            sportsbookArb: { ...cur.sportsbookArb, status: 'scanning' },
          });
        });

        sbArb.on('scanned', (result: SportsbookArbScanResult) => {
          sbArbRequestStats = {
            today:       result.requestsToday,
            month:       result.requestsThisMonth,
            quota:       result.monthlyQuota,
            nearCeiling: result.quotaNearCeiling,
          };
          dashboardEmitter.log(
            'INFO',
            `SportsbookArb: ${result.fixturesLive} live / ${result.fixturesPregame} pregame in odds window ` +
            `| Polymarket matches: ${result.fixturesMatchedToPolymarket} ` +
            `| OddsPapi: ${result.requestsToday} today / ${result.requestsThisMonth} this month` +
            (result.quotaNearCeiling ? ' ⚠ NEAR QUOTA CEILING' : ''),
          );
          const cur = dashboardEmitter.getState();
          if (cur) {
            const ratio = result.fixturesTotal > 0
              ? result.fixturesMatchedToPolymarket / result.fixturesTotal
              : 0;
            dashboardEmitter.updateState({
              ...cur,
              sportsbookArb: {
                ...cur.sportsbookArb,
                status:                  'scanning',
                fixturesScanned:         result.fixturesTotal,
                polymarketCoverageRatio: ratio,
              },
            });
          }
        });

        sbArb.on('signal', (signal: SportsbookArbSignal) => {
          for (const leg of signal.legs) {
            dashboardEmitter.log(
              'SIGNAL',
              `SportsbookArb VALUE BET — ${signal.participant1Name} vs ${signal.participant2Name} ` +
              `[${signal.tournamentName}] ` +
              `outcome=${leg.outcomeName} ` +
              `Betfair back=${leg.betfairBackPrice.toFixed(2)} lay=${leg.betfairLayPrice.toFixed(2)} ` +
              `→ fair=${(leg.fairProbability * 100).toFixed(1)}% ` +
              `vs Poly=${(leg.polymarketPrice * 100).toFixed(1)}% ` +
              `edge=${(leg.edge * 100).toFixed(1)}pp ` +
              `E[net]=$${leg.expectedNetProfitUSD.toFixed(4)} ` +
              `conf=${(signal.confidence * 100).toFixed(0)}% ` +
              `market="${leg.polymarketQuestion}" ` +
              `(detection only — directional bet, NOT risk-free)`,
            );

            // conditionId comes directly from the Gamma API match — no CLOB scan needed.
            // token_id was resolved in-service via CLOB GET /markets/{conditionId}.
            // Both are now reliable. If token_id is missing (CLOB lookup failed),
            // the paper-trade-resolver will re-derive it on settlement using conditionId.
            const paperShares = Math.max(1, Math.floor(10 / leg.polymarketPrice));
            const marketLabel = `${signal.participant1Name} vs ${signal.participant2Name} — ${leg.outcomeName}`;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any).from('paper_trades').insert({
              module:         'sportsbook-arb',
              market_label:   marketLabel,
              net_profit_usd: null,
              shares:         paperShares,
              entry_price:    leg.polymarketPrice,
              token_id:       leg.tokenId ?? null,
              condition_id:   leg.polymarketConditionId,
              status:         'open',
              metadata:       signal as unknown as Record<string, unknown>,
              trading_mode:   cfg.tradingMode,
            }).then(({ error }: { error: { message: string } | null }) => {
              if (error) {
                dashboardEmitter.log('WARN', `SportsbookArb paper trade insert failed: ${error.message}`);
              }
            });
          }
          const cur = dashboardEmitter.getState();
          if (cur && signal.legs.length > 0) {
            const bestLeg = signal.legs[0];
            const newSignal = {
              participant1Name:     signal.participant1Name,
              participant2Name:     signal.participant2Name,
              tournamentName:       signal.tournamentName,
              outcomeName:          bestLeg.outcomeName,
              edge:                 bestLeg.edge,
              expectedNetProfitUSD: bestLeg.expectedNetProfitUSD,
              confidence:           signal.confidence,
              timestamp:            new Date().toISOString(),
            };
            const prev = cur.sportsbookArb.recentSignals ?? [];
            dashboardEmitter.updateState({
              ...cur,
              sportsbookArb: {
                ...cur.sportsbookArb,
                lastSignal:    newSignal,
                recentSignals: [newSignal, ...prev].slice(0, 10),
              },
            });
          }
        });

        sbArb.on('stopped', () => {
          dashboardEmitter.log('INFO', 'SportsbookArb scanner stopped');
          const cur = dashboardEmitter.getState();
          if (cur) dashboardEmitter.updateState({
            ...cur,
            sportsbookArb: { ...cur.sportsbookArb, status: 'idle' },
          });
        });

        sbArb.on('error', (err: Error) => {
          dashboardEmitter.log('ERROR', `SportsbookArb error: ${err.message}`);
        });

        await sbArb.start();

        // Hold alive: SportsbookArbService drives itself via polling timer.
        // Reject on the first unrecoverable error so runWithRestart resets.
        try {
          await new Promise<never>((_, reject) => {
            sbArb.once('error', (err: Error) => reject(err));
          });
        } finally {
          sbArb.stop();
        }
      },
    },
    {
      // Runs alongside sportsbook-arb: polls Supabase every 10 min for open
      // sportsbook-arb paper trades and resolves them via the Gamma API.
      // Enabled whenever sportsbook-arb is enabled (same env flag).
      name:    'paper-trade-resolver',
      enabled: process.env.ENABLE_SPORTSBOOK_ARB === 'true',
      run:     runPaperTradeResolver,
    },
    {
      // pair-discovery is ALWAYS enabled at boot so it can poll bot_config
      // and start/stop/reschedule PairDiscoveryService without a redeploy.
      // The module idles silently until the dashboard enables it.
      // ANTHROPIC_API_KEY is only validated when a scan is about to run.
      name:    'pair-discovery',
      enabled: true,
      run:     async (): Promise<void> => {
        const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

        let discovery: PairDiscoveryService | null = null;
        let runningEnabled   = false;
        let runningIntervalH = 0;

        // ── helpers ──────────────────────────────────────────────────────────

        async function readPairDiscoveryConfig(): Promise<{ enabled: boolean; intervalHours: number } | null> {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data, error } = await (supabase as any)
              .from('bot_config')
              .select('key, value')
              .eq('module', 'pair-discovery');
            if (error || !Array.isArray(data)) return null;
            const rows = data as Array<{ key: string; value: string }>;
            const enabledRow  = rows.find((r) => r.key === 'enabled');
            const intervalRow = rows.find((r) => r.key === 'interval_hours');
            const enabled      = enabledRow  ? enabledRow.value  === 'true' : false;
            const intervalHours = intervalRow ? parseFloat(intervalRow.value) : 6;
            if (isNaN(intervalHours) || intervalHours <= 0) return { enabled: false, intervalHours: 6 };
            return { enabled, intervalHours };
          } catch {
            return null;  // transient error — keep current state
          }
        }

        function wireDiscoveryEvents(svc: PairDiscoveryService, intervalH: number): void {
          svc.on('started', () => {
            dashboardEmitter.log(
              'INFO',
              `PairDiscovery service started — interval: ${intervalH}h ` +
              `(writes to correlated_pair_suggestions only; approval is manual)`,
            );
          });
          svc.on('run-started', () => {
            dashboardEmitter.log('INFO', 'PairDiscovery: discovery run started');
          });
          svc.on('run-complete', (stats: { inserted: number; discarded: number; total: number; nextRunMs: number }) => {
            const nextH = (stats.nextRunMs / 3_600_000).toFixed(2);
            dashboardEmitter.log(
              'INFO',
              `PairDiscovery run complete: ${stats.inserted} suggestions inserted, ` +
              `${stats.discarded} discarded of ${stats.total} candidates. ` +
              `Next run in ${nextH}h. ` +
              `Review: npx tsx scripts/review-pair-suggestions.ts`,
            );
          });
          svc.on('stopped', () => {
            dashboardEmitter.log('INFO', 'PairDiscovery service stopped');
          });
          svc.on('error', (err: Error) => {
            dashboardEmitter.log('ERROR', `PairDiscovery error: ${err.message}`);
          });
        }

        async function startDiscovery(intervalH: number): Promise<void> {
          const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
          if (!anthropicApiKey) {
            dashboardEmitter.log(
              'WARN',
              'PairDiscovery: ANTHROPIC_API_KEY not set — cannot start scanning. ' +
              'Set ANTHROPIC_API_KEY and re-enable from the dashboard.',
            );
            // Roll back in-memory enabled flag so next poll tries again cleanly.
            runningEnabled = false;
            return;
          }
          const sdk = await PolymarketSDK.create({
            privateKey: process.env.POLYMARKET_PRIVATE_KEY,
          });
          const svc = new PairDiscoveryService(
            sdk.gammaApi,
            supabase,
            anthropicApiKey,
            { intervalMs: intervalH * 60 * 60 * 1000 },
          );
          wireDiscoveryEvents(svc, intervalH);
          await svc.start();
          discovery          = svc;
          runningEnabled     = true;
          runningIntervalH   = intervalH;
          log.info('PairDiscovery started via dashboard config', { intervalH });
        }

        function stopDiscovery(): void {
          if (discovery) {
            discovery.stop();
            discovery = null;
          }
          runningEnabled   = false;
          runningIntervalH = 0;
          log.info('PairDiscovery stopped via dashboard config');
        }

        async function applyConfig(dbCfg: { enabled: boolean; intervalHours: number } | null): Promise<void> {
          if (!dbCfg) return;  // transient DB error — keep current state

          const { enabled, intervalHours } = dbCfg;

          // Always mirror latest config to the dashboard so the UI stays in sync.
          const currentConfig = dashboardEmitter.getConfig();
          if (currentConfig) {
            dashboardEmitter.updateConfig({
              ...currentConfig,
              pairDiscovery: { enabled, intervalHours },
            });
          }

          const intervalChanged = runningEnabled && runningIntervalH !== intervalHours;

          if (enabled && (!runningEnabled || intervalChanged)) {
            // Start (or restart with new interval).
            if (discovery) stopDiscovery();
            await startDiscovery(intervalHours);
          } else if (!enabled && runningEnabled) {
            stopDiscovery();
          }
          // else: state matches — nothing to do
        }

        // ── initial read ─────────────────────────────────────────────────────
        const initialCfg = await readPairDiscoveryConfig();
        await applyConfig(initialCfg);

        // ── poll loop ─────────────────────────────────────────────────────────
        while (!shuttingDown) {
          await sleep(POLL_INTERVAL_MS);
          const dbCfg = await readPairDiscoveryConfig();
          await applyConfig(dbCfg);
        }

        // Cleanup on shutdown — cast needed: TS narrows to never after the poll loop
        // because it reasons stopDiscovery() (which sets discovery=null) is the last
        // assignment; the cast restores the actual runtime type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (discovery as any)?.stop();
      },
    },
    // market-making: not yet implemented
    {
      name:    'market-making',
      enabled: cfg.enableMarketMaking,
      run:     async () => {
        log.info('market-making module not yet implemented — skipping');
      },
    },
  ];

  for (const mod of moduleDefinitions) {
    if (mod.enabled) {
      activeModules.push(mod.name);
      log.info('Module enabled', { module: mod.name });
    } else {
      disabledModules.push(mod.name);
      log.info('Module disabled', { module: mod.name });
    }
  }

  // ── 7. Push initial state + config to dashboard ──────────────────────────
  const startedAt = Date.now();

  const initialBotState: BotState = {
    startTime:           startedAt,
    dailyPnL:            0,
    totalPnL:            0,
    consecutiveLosses:   0,
    consecutiveWins:     0,
    tradesExecuted:      0,
    isPaused:            false,
    pauseUntil:          0,
    monthlyPnL:          0,
    monthStartTime:      startedAt,
    peakCapital:         0,
    currentCapital:      0,
    currentDrawdown:     0,
    permanentlyHalted:   false,
    lastDailyReset:      startedAt,
    smartMoneyTrades:    0,
    arbTrades:           0,
    dipArbTrades:        0,
    directTrades:        0,
    arbProfit:           0,
    followedWallets:     [],
    positions:           [],
    activeArbMarket:     null,
    activeDipArbMarket:  null,
    splits:              0,
    merges:              0,
    redeems:             0,
    swaps:               0,
    usdcBalance:         0,
    usdcEBalance:        0,
    maticBalance:        0,
    unrealizedPnL:       0,
    btcTrend:            'neutral',
    ethTrend:            'neutral',
    solTrend:            'neutral',
    dipArb: {
      marketName: null,
      underlying: null,
      duration:   null,
      endTime:    null,
      upPrice:    0,
      downPrice:  0,
      sum:        0,
      status:     'idle',
      lastSignal: null,
      signals:    [],
    },
    arbitrage: {
      status:             'idle',
      marketsScanned:     0,
      opportunitiesFound: 0,
      currentMarket:      null,
      lastOpportunity:    null,
    },
    smartMoneySignals: [],
    negRiskArb: {
      status:          'idle',
      eventsScanned:   0,
      candidatesFound: 0,
      lastSignal:      null,
      recentSignals:   [],
    },
    logicArb: {
      status:       'idle',
      pairsTracked: 0,
      pairsScanned: 0,
      lastSignal:   null,
      recentSignals: [],
    },
    sportsbookArb: {
      status:                  'idle',
      fixturesScanned:         0,
      polymarketCoverageRatio: 0,
      lastSignal:              null,
      recentSignals:           [],
    },
  };

  const initialBotConfig: BotConfig = {
    capital: {
      totalUsd:            0,
      maxPerTradePct:      0,
      maxPerMarketPct:     0,
      maxTotalExposurePct: 0,
      minOrderUsd:         0,
      strategyAllocation:  { smartMoney: 0, arbitrage: 0, dipArb: 0, directTrades: 0 },
    },
    risk: {
      dailyMaxLossPct:      0,
      maxConsecutiveLosses: 0,
      pauseOnBreachMinutes: 0,
    },
    smartMoney:    { enabled: false, topN: 0, minWinRate: 0, minPnl: 0, minTrades: 0, customWallets: [] },
    arbitrage:     { enabled: false, profitThreshold: 0, autoExecute: false },
    dipArb:        { enabled: process.env.ENABLE_DIP_ARB === 'true', coins: ['BTC', 'ETH', 'SOL'] },
    negRiskArb:    { enabled: process.env.ENABLE_NEGRISK_ARB === 'true' },
    logicArb:      { enabled: process.env.ENABLE_LOGIC_ARB === 'true' },
    sportsbookArb: { enabled: process.env.ENABLE_SPORTSBOOK_ARB === 'true' },
    directTrading: { enabled: false },
    binance:       { enabled: false },
    pairDiscovery: { enabled: false, intervalHours: 6 },
    dryRun:        cfg.tradingMode !== 'live',
  };

  dashboardEmitter.updateState(initialBotState);
  dashboardEmitter.updateConfig(initialBotConfig);
  dashboardEmitter.log('INFO', 'Bot started', { activeModules, disabledModules, tradingMode: cfg.tradingMode });

  if (activeModules.length === 0) {
    log.warn('No modules enabled — bot is running but not trading', {
      hint: 'Set ENABLE_LATENCY_SNIPER=true (or other modules) in .env',
    });
  }

  // ── 8. Start periodic status reporter ────────────────────────────────────
  const statusTimer = startStatusReporter(activeModules);

  // ── 9. Launch enabled modules concurrently ────────────────────────────────
  console.log('Starting modules...');
  const modulePromises = moduleDefinitions
    .filter((m) => m.enabled)
    .map((m) => runWithRestart(m.name, m.run));

  // Health server's listen() keeps the event loop alive even if all modules
  // exit (e.g., all stubs). If we somehow have nothing to wait on, add a
  // keep-alive so the process doesn't exit.
  const keepAlive = setInterval(() => {}, 60_000);

  log.info('All modules launched', { count: modulePromises.length, activeModules });

  // Wait for all modules to settle (long-running modules never resolve)
  const results = await Promise.allSettled(modulePromises);

  clearInterval(statusTimer);
  clearInterval(keepAlive);

  // Log any unexpected module exits
  for (const [i, result] of results.entries()) {
    const name = moduleDefinitions.filter((m) => m.enabled)[i]?.name ?? 'unknown';
    if (result.status === 'rejected') {
      log.error('Module exited with error (should not happen — runWithRestart swallows)', {
        module: name,
        reason: String(result.reason),
      });
    } else {
      log.info('Module exited normally', { module: name });
    }
  }

  log.info('All modules finished — process will stay alive via dashboard server');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[FATAL] main() threw unexpectedly:', err);
  process.exit(1);
});
