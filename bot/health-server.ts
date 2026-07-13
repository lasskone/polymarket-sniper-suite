/**
 * bot/health-server.ts — HTTP health + dashboard server.
 *
 * Endpoints:
 *   GET /           → serves the built React dashboard (dashboard/dist)
 *   GET /health     → { status, uptime, modules, tradingMode }
 *   GET /status     → extended state
 *   GET /api/trades        → last 20 trades from Supabase
 *   GET /api/opportunities → last 20 opportunities from Supabase
 *   GET /api/performance   → today's performance stats from Supabase
 *   WS  /           → WebSocket feed for the live dashboard
 *
 * The WebSocket connection pushes live BotState to the dashboard
 * every 5 seconds and immediately on state changes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createLogger } from '../modules/shared/logger.js';

const log = createLogger('health-server');

// ---------------------------------------------------------------------------
// Static asset serving
// ---------------------------------------------------------------------------

// When compiled: dist/bot/health-server.js → ../../dashboard/dist
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DASHBOARD_DIR = join(__dirname, '../../dashboard/dist');

const MIME: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.ico':   'image/x-icon',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  let pathname = url.pathname;

  // Never serve files for API or health routes
  if (pathname.startsWith('/api/') || pathname === '/health' || pathname === '/status') {
    return false;
  }

  // Default to index.html for SPA routing
  if (pathname === '/' || !pathname.includes('.')) {
    pathname = '/index.html';
  }

  const filePath = join(DASHBOARD_DIR, pathname);

  try {
    const data = await readFile(filePath);
    const ext  = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    // File not found — fall through to SPA fallback
    try {
      const data = await readFile(join(DASHBOARD_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared bot state — pushed in from the orchestrator
// ---------------------------------------------------------------------------

export interface BotStatus {
  activeModules:        string[];
  disabledModules:      string[];
  tradingMode:          'paper' | 'live';
  tradesExecuted:       number;
  opportunitiesFound:   number;
  errors:               number;
  circuitBreakerActive: boolean;
  startedAt:            number;  // Date.now()
}

const state: BotStatus = {
  activeModules:        [],
  disabledModules:      [],
  tradingMode:          'paper',
  tradesExecuted:       0,
  opportunitiesFound:   0,
  errors:               0,
  circuitBreakerActive: false,
  startedAt:            Date.now(),
};

export function updateBotStatus(patch: Partial<BotStatus>): void {
  Object.assign(state, patch);
  broadcastState();
}

export function incrementTrades():        void { state.tradesExecuted++;     broadcastState(); }
export function incrementOpportunities(): void { state.opportunitiesFound++; broadcastState(); }
export function incrementErrors():        void { state.errors++;             }

// ---------------------------------------------------------------------------
// WebSocket — live dashboard feed
// ---------------------------------------------------------------------------

const wsClients = new Set<WebSocket>();

/** Map internal BotStatus → dashboard BotState shape */
function buildDashboardState() {
  return {
    startTime:           state.startedAt,
    dailyPnL:            0,
    totalPnL:            0,
    consecutiveLosses:   0,
    tradesExecuted:      state.tradesExecuted,
    isPaused:            state.circuitBreakerActive,
    pauseUntil:          0,
    smartMoneyTrades:    0,
    arbTrades:           0,
    dipArbTrades:        0,
    directTrades:        0,
    arbProfit:           0,
    followedWallets:     [],
    activeArbMarket:     null,
    activeDipArbMarket:  null,
    splits:  0,
    merges:  0,
    redeems: 0,
    swaps:   0,
    usdcBalance:    0,
    usdcEBalance:   0,
    maticBalance:   0,
    unrealizedPnL:  0,
    btcTrend:  'neutral' as const,
    ethTrend:  'neutral' as const,
    solTrend:  'neutral' as const,
    positions: [],
  };
}

/** Map internal BotStatus → dashboard BotConfig shape */
function buildDashboardConfig() {
  return {
    capital: {
      totalUsd: 0,
      maxPerTradePct: 0,
      maxPerMarketPct: 0,
      maxTotalExposurePct: 0,
      minOrderUsd: 0,
      strategyAllocation: { smartMoney: 0, arbitrage: 0, dipArb: 0, directTrades: 0 },
    },
    risk: { dailyMaxLossPct: 0, maxConsecutiveLosses: 0, pauseOnBreachMinutes: 0 },
    smartMoney: { enabled: false, topN: 0, minWinRate: 0, minPnl: 0, minTrades: 0, customWallets: [] },
    arbitrage:  { enabled: state.activeModules.includes('resolution-arb'), profitThreshold: 0, autoExecute: false },
    dipArb:     { enabled: false, coins: [] as readonly string[] },
    directTrading: { enabled: false },
    binance:    { enabled: false },
    dryRun:     state.tradingMode === 'paper',
  };
}

function broadcastState(): void {
  if (wsClients.size === 0) return;
  const message = JSON.stringify({ type: 'state', payload: buildDashboardState() });
  for (const client of wsClients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(message);
    }
  }
}

function sendFullSnapshot(ws: WebSocket): void {
  ws.send(JSON.stringify({
    type: 'full',
    payload: {
      state:  buildDashboardState(),
      config: buildDashboardConfig(),
      logs:   [],
    },
  }));
}

// ---------------------------------------------------------------------------
// Supabase API helpers
// ---------------------------------------------------------------------------

async function querySupabase(table: string, query: Record<string, string>): Promise<unknown> {
  // Lazy import so the server still starts if Supabase env vars are missing
  try {
    const { getSupabaseClient } = await import('../modules/shared/supabase-client.js');
    const client = getSupabaseClient();

    let builder = client.from(table).select('*');

    if (query.order)  builder = (builder as any).order(query.order, { ascending: false });
    if (query.limit)  builder = (builder as any).limit(parseInt(query.limit, 10));
    if (query.filter) {
      const [col, val] = query.filter.split('=');
      builder = (builder as any).eq(col, val);
    }

    const { data, error } = await builder;
    if (error) throw error;
    return data;
  } catch (err) {
    log.error('querySupabase failed', { table, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url  = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method !== 'GET') {
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  // ── Health & Status ────────────────────────────────────────────────────────
  if (url === '/health' || url === '/health/') {
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    respond(res, 200, {
      status:      'ok',
      uptime:      uptimeSec,
      modules:     state.activeModules,
      tradingMode: state.tradingMode,
    });
    return;
  }

  if (url === '/status' || url === '/status/') {
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    respond(res, 200, {
      status:               'ok',
      uptime:               uptimeSec,
      startedAt:            new Date(state.startedAt).toISOString(),
      tradingMode:          state.tradingMode,
      activeModules:        state.activeModules,
      disabledModules:      state.disabledModules,
      tradesExecuted:       state.tradesExecuted,
      opportunitiesFound:   state.opportunitiesFound,
      errors:               state.errors,
      circuitBreakerActive: state.circuitBreakerActive,
    });
    return;
  }

  // ── Supabase API routes ───────────────────────────────────────────────────
  if (url === '/api/trades' || url === '/api/trades/') {
    const data = await querySupabase('trades', { order: 'created_at', limit: '20' });
    respond(res, data ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  if (url === '/api/opportunities' || url === '/api/opportunities/') {
    const data = await querySupabase('opportunities', { order: 'detected_at', limit: '20' });
    respond(res, data ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  if (url === '/api/performance' || url === '/api/performance/') {
    const today = new Date().toISOString().split('T')[0];
    const data  = await querySupabase('performance', {
      order:  'date',
      filter: `date=${today}`,
      limit:  '10',
    });
    respond(res, data ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  // ── Static dashboard ──────────────────────────────────────────────────────
  const served = await serveStatic(req, res);
  if (!served) {
    respond(res, 404, { error: 'Not Found', path: url });
  }
}

function respond(res: ServerResponse, code: number, body: object | unknown[]): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server:   ReturnType<typeof createServer> | null = null;
let wss:      WebSocketServer | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

export function startHealthServer(port: number): void {
  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('Unhandled request error', { error: String(err) });
      if (!res.headersSent) respond(res, 500, { error: 'Internal Server Error' });
    });
  });

  // WebSocket server — upgrade on the same HTTP server
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    log.info('Dashboard client connected', { clients: wsClients.size });

    // Send full snapshot immediately on connect
    sendFullSnapshot(ws);

    ws.on('close', () => {
      wsClients.delete(ws);
      log.info('Dashboard client disconnected', { clients: wsClients.size });
    });

    ws.on('error', (err) => {
      log.error('WebSocket client error', { error: String(err) });
      wsClients.delete(ws);
    });

    // Handle commands from the dashboard (e.g. toggleDryRun)
    ws.on('message', (raw) => {
      try {
        const cmd = JSON.parse(raw.toString());
        log.info('Dashboard command received', { command: cmd.command });
        // Future: dispatch commands to the orchestrator
      } catch {
        log.error('Invalid WebSocket message', { raw: raw.toString().slice(0, 100) });
      }
    });
  });

  server.on('error', (err) => {
    log.error('Health server error', { error: String(err) });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Health server ready on 0.0.0.0:${port}`);
    log.info('Health server listening', {
      port,
      endpoints: ['/health', '/status', '/api/trades', '/api/opportunities', '/api/performance'],
      dashboard: `http://0.0.0.0:${port}/`,
    });
  });

  // Push state to all WS clients every 5 seconds
  interval = setInterval(broadcastState, 5_000);
}

export function stopHealthServer(): Promise<void> {
  if (interval) { clearInterval(interval); interval = null; }
  return new Promise((resolve) => {
    wss?.close();
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}
