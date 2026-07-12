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
 *   1. Load + validate config (fatal on error)
 *   2. Start health server immediately (Railway needs /health early)
 *   3. Verify Supabase connection (non-fatal warning if unavailable)
 *   4. Initialize shared services (RiskManager)
 *   5. Start enabled modules concurrently via Promise.allSettled()
 *   6. Periodic status log every 5 minutes
 *   7. Graceful shutdown on SIGTERM / SIGINT
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
  startHealthServer,
  stopHealthServer,
  updateBotStatus,
  incrementErrors,
} from './health-server.js';

const log = createLogger('main');

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

  stopHealthServer()
    .then(() => {
      log.info('Health server stopped. Goodbye.');
      process.exit(0);
    })
    .catch(() => process.exit(1));
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT',  () => requestShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  incrementErrors();
  // Don't exit — keep the bot running
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { reason: String(reason) });
  incrementErrors();
});

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
      // If fn() returns normally (stub module), just exit loop — don't loop forever
      log.info(`Module exited cleanly`, { module: name });
      return;
    } catch (err) {
      incrementErrors();
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
    });
  }, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 1. Load config ────────────────────────────────────────────────────────
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    // Config errors are fatal — can't start without valid config
    console.error('[FATAL] Config failed to load:', String(err));
    process.exit(1);
  }

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

  // ── 2. Start health server immediately ───────────────────────────────────
  // Railway needs /health to respond quickly during deployment checks.
  const port = Number(process.env.PORT ?? 8080);
  startHealthServer(port);

  // ── 3. Supabase connection (non-fatal) ────────────────────────────────────
  const supabase = getSupabaseClient();
  try {
    await verifySupabaseConnection();
    log.info('Supabase connection verified');
  } catch (err) {
    log.warn('Supabase connection failed — trades will not be persisted', {
      error: String(err),
    });
    // Continue — bot can still run in paper mode without Supabase
  }

  // ── 4. Shared services ────────────────────────────────────────────────────
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

  // ── 5. Resolve enabled / disabled modules ─────────────────────────────────
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

  // ── 6. Push state to health server ───────────────────────────────────────
  updateBotStatus({
    activeModules,
    disabledModules,
    tradingMode:  cfg.tradingMode,
    startedAt:    Date.now(),
  });

  if (activeModules.length === 0) {
    log.warn('No modules enabled — bot is running but not trading', {
      hint: 'Set ENABLE_LATENCY_SNIPER=true (or other modules) in .env',
    });
  }

  // ── 7. Start periodic status reporter ────────────────────────────────────
  const statusTimer = startStatusReporter(activeModules);

  // ── 8. Launch enabled modules concurrently ────────────────────────────────
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

  log.info('All modules finished — process will stay alive via health server');
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
