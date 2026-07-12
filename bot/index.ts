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
 *   2. Start health server immediately (sync, binds to 0.0.0.0)
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
  startHealthServer,
  stopHealthServer,
  updateBotStatus,
  incrementErrors,
} from './health-server.js';

// ---------------------------------------------------------------------------
// Step 1: Error handlers — registered before anything else so no exception
//         can silently kill the process (and take the health server with it).
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  incrementErrors();
  // Don't exit — keep the bot running
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  incrementErrors();
});

// ---------------------------------------------------------------------------
// Step 2: Start health server IMMEDIATELY — synchronous call, no awaiting.
//         Railway health checks begin as soon as the container starts, so
//         this must happen before any async I/O (Supabase, APIs, etc.).
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8080', 10);
console.log(`Starting health server on port ${PORT}`);
startHealthServer(PORT);
// "Health server ready" is logged inside startHealthServer's listen callback.

// ---------------------------------------------------------------------------
// Logger — initialised after health server so it can't block step 2.
// ---------------------------------------------------------------------------

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

  // ── 7. Push state to health server ───────────────────────────────────────
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
