/**
 * bot/health-server.ts — HTTP + WebSocket dashboard server.
 *
 * Endpoints:
 *   GET /                    → public/dashboard.html (professional multi-strategy dashboard)
 *   GET /health              → { status, uptime, modules, tradingMode }
 *   GET /status              → full bot state
 *   GET /api/strategies      → all 6 strategies with live status
 *   GET /api/trades          → Supabase trades (filterable: ?module=&limit=)
 *   GET /api/opportunities   → Supabase opportunities (filterable: ?module=&limit=)
 *   GET /api/performance     → Supabase performance rows (last 30 days)
 *   GET /api/activity        → in-memory activity log (?level=&strategy=&limit=)
 *   GET /api/stats           → process/memory/WS stats
 *   WS  /                    → real-time state + activity push
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createLogger } from '../modules/shared/logger.js';

const log = createLogger('health-server');

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);
// dist/bot/health-server.js → ../../public
const PUBLIC_DIR  = join(__dirname, '../../public');

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
};

// ---------------------------------------------------------------------------
// Strategy definitions (canonical list — 6 strategies)
// ---------------------------------------------------------------------------

const STRATEGY_DEFS = [
  { id: 'latency-sniper',    name: 'Latency Sniper',      icon: '⚡', color: '#3fb950', module: 'latency-sniper'    },
  { id: 'resolution-arb',   name: 'Resolution Arb',      icon: '⏳', color: '#d29922', module: 'resolution-arb'    },
  { id: 'cross-market-arb', name: 'Arbitrage Monitor',   icon: '📊', color: '#58a6ff', module: 'cross-market-arb'  },
  { id: 'dip-arb',           name: 'DipArb Monitor',     icon: '📉', color: '#f0883e', module: null                },
  { id: 'smart-money',       name: 'Smart Money Tracker',icon: '🐋', color: '#a5a3ff', module: null                },
  { id: 'direct-trading',    name: 'Direct Trading',     icon: '🎯', color: '#39d0d8', module: 'market-making'     },
] as const;

// ---------------------------------------------------------------------------
// Activity log (in-memory ring buffer, 200 entries)
// ---------------------------------------------------------------------------

export type ActivityLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'SIGNAL' | 'OPPORTUNITY';

export interface ActivityEntry {
  id:        string;
  timestamp: string;
  level:     ActivityLevel;
  strategy:  string;
  message:   string;
  data?:     unknown;
}

const activityLog: ActivityEntry[] = [];
const MAX_ACTIVITY = 200;
let   activitySeq  = 0;

/**
 * Add an entry to the in-memory activity log and broadcast to all WS clients.
 * Called by bot modules to stream live events to the dashboard.
 */
export function logActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
  const item: ActivityEntry = {
    id:        `act-${++activitySeq}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  activityLog.unshift(item);
  if (activityLog.length > MAX_ACTIVITY) activityLog.length = MAX_ACTIVITY;
  broadcastJson({ type: 'activity', payload: item });
}

// ---------------------------------------------------------------------------
// Bot state (pushed in from orchestrator)
// ---------------------------------------------------------------------------

export interface BotStatus {
  activeModules:        string[];
  disabledModules:      string[];
  tradingMode:          'paper' | 'live';
  tradesExecuted:       number;
  opportunitiesFound:   number;
  errors:               number;
  circuitBreakerActive: boolean;
  startedAt:            number;
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
// State builders
// ---------------------------------------------------------------------------

function buildStrategies() {
  return STRATEGY_DEFS.map(s => ({
    id:     s.id,
    name:   s.name,
    icon:   s.icon,
    color:  s.color,
    module: s.module,
    status: s.module === null
      ? 'disabled'
      : state.activeModules.includes(s.module) ? 'active' : 'idle',
  }));
}

function buildStats() {
  const mem = process.memoryUsage();
  return {
    wsClients:  wsClients.size,
    uptime:     Math.floor(process.uptime()),
    memMb: {
      heap:      (mem.heapUsed   / 1_048_576).toFixed(1),
      heapTotal: (mem.heapTotal  / 1_048_576).toFixed(1),
      rss:       (mem.rss        / 1_048_576).toFixed(1),
    },
    errors:    state.errors,
    startedAt: new Date(state.startedAt).toISOString(),
  };
}

function buildFullState() {
  return {
    uptime:               Math.floor((Date.now() - state.startedAt) / 1000),
    tradingMode:          state.tradingMode,
    activeModules:        state.activeModules,
    disabledModules:      state.disabledModules,
    tradesExecuted:       state.tradesExecuted,
    opportunitiesFound:   state.opportunitiesFound,
    errors:               state.errors,
    circuitBreakerActive: state.circuitBreakerActive,
    strategies:           buildStrategies(),
    stats:                buildStats(),
  };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wsClients = new Set<WebSocket>();

function broadcastJson(payload: object): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

function broadcastState(): void {
  broadcastJson({ type: 'state', payload: buildFullState() });
}

// ---------------------------------------------------------------------------
// Supabase helper
// ---------------------------------------------------------------------------

async function supabaseQuery(
  table: string,
  opts: {
    select?:    string;
    orderCol?:  string;
    limit?:     number;
    eq?:        [string, string];
    gte?:       [string, string];
  } = {},
): Promise<unknown> {
  try {
    const { getSupabaseClient } = await import('../modules/shared/supabase-client.js');
    const client = getSupabaseClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = client.from(table as any).select(opts.select ?? '*');
    if (opts.eq)       q = q.eq(opts.eq[0], opts.eq[1]);
    if (opts.gte)      q = q.gte(opts.gte[0], opts.gte[1]);
    if (opts.orderCol) q = q.order(opts.orderCol, { ascending: false });
    if (opts.limit)    q = q.limit(opts.limit);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  } catch (err) {
    log.error('supabaseQuery failed', { table, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static file helper
// ---------------------------------------------------------------------------

async function serveFile(res: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const data = await readFile(filePath);
    const ext  = extname(filePath);
    res.writeHead(200, {
      'Content-Type':  MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlStr = req.url ?? '/';
  const url    = new URL(urlStr, 'http://localhost');
  const path   = url.pathname.replace(/\/$/, '') || '/';
  const method = req.method ?? 'GET';

  // Global CORS header
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (method !== 'GET') {
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (path === '/health') {
    respond(res, 200, {
      status:      'ok',
      uptime:      Math.floor((Date.now() - state.startedAt) / 1000),
      modules:     state.activeModules,
      tradingMode: state.tradingMode,
    });
    return;
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  if (path === '/status') {
    respond(res, 200, buildFullState());
    return;
  }

  // ── API: strategies ────────────────────────────────────────────────────────
  if (path === '/api/strategies') {
    respond(res, 200, buildStrategies());
    return;
  }

  // ── API: stats ─────────────────────────────────────────────────────────────
  if (path === '/api/stats') {
    respond(res, 200, buildStats());
    return;
  }

  // ── API: activity ──────────────────────────────────────────────────────────
  if (path === '/api/activity') {
    const limit    = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 200);
    const level    = url.searchParams.get('level')?.toUpperCase();
    const strategy = url.searchParams.get('strategy');

    let entries = activityLog as ActivityEntry[];
    if (level    && level !== 'ALL') entries = entries.filter(e => e.level    === level);
    if (strategy)                    entries = entries.filter(e => e.strategy === strategy);

    respond(res, 200, entries.slice(0, limit));
    return;
  }

  // ── API: trades ────────────────────────────────────────────────────────────
  if (path === '/api/trades') {
    const module = url.searchParams.get('module') ?? undefined;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    const data   = await supabaseQuery('trades', {
      orderCol: 'created_at',
      limit,
      ...(module ? { eq: ['module', module] as [string, string] } : {}),
    });
    respond(res, data !== null ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  // ── API: opportunities ─────────────────────────────────────────────────────
  if (path === '/api/opportunities') {
    const module = url.searchParams.get('module') ?? undefined;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    const data   = await supabaseQuery('opportunities', {
      orderCol: 'detected_at',
      limit,
      ...(module ? { eq: ['module', module] as [string, string] } : {}),
    });
    respond(res, data !== null ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  // ── API: performance ───────────────────────────────────────────────────────
  if (path === '/api/performance') {
    // Return last 30 days across all modules
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];
    const data   = await supabaseQuery('performance', {
      orderCol: 'date',
      limit:    200,
      gte:      ['date', cutoff],
    });
    respond(res, data !== null ? 200 : 503, data ?? { error: 'Supabase unavailable' });
    return;
  }

  // ── Static: root & dashboard ───────────────────────────────────────────────
  if (path === '/' || path === '/dashboard') {
    const ok = await serveFile(res, join(PUBLIC_DIR, 'dashboard.html'));
    if (!ok) respond(res, 503, { error: 'Dashboard not built yet — public/dashboard.html missing' });
    return;
  }

  // ── Static: other public assets (favicon, etc.) ───────────────────────────
  if (path.includes('.')) {
    const ok = await serveFile(res, join(PUBLIC_DIR, path));
    if (ok) return;
  }

  respond(res, 404, { error: 'Not Found', path });
}

function respond(res: ServerResponse, code: number, body: object | unknown[]): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server:           ReturnType<typeof createServer> | null = null;
let wss:              WebSocketServer | null = null;
let broadcastInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthServer(port: number): void {
  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('Unhandled request error', { error: String(err) });
      if (!res.headersSent) respond(res, 500, { error: 'Internal Server Error' });
    });
  });

  // WebSocket server piggybacks on same HTTP server
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    log.info('Dashboard client connected', { totalClients: wsClients.size });

    // Immediately push full state + recent activity history
    ws.send(JSON.stringify({ type: 'state', payload: buildFullState() }));
    ws.send(JSON.stringify({ type: 'activity_history', payload: activityLog.slice(0, 50) }));

    ws.on('close', () => { wsClients.delete(ws); });
    ws.on('error', () => { wsClients.delete(ws); });

    ws.on('message', (raw) => {
      try {
        const cmd = JSON.parse(raw.toString());
        log.info('Dashboard WS command', { command: cmd.command });
      } catch {
        // ignore malformed messages
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
      host: '0.0.0.0',
      endpoints: ['/health', '/status', '/api/strategies', '/api/trades',
                  '/api/opportunities', '/api/performance', '/api/activity', '/api/stats'],
    });
  });

  // Broadcast state to all WS clients every 5 seconds
  broadcastInterval = setInterval(broadcastState, 5_000);
}

export function stopHealthServer(): Promise<void> {
  if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
  return new Promise((resolve) => {
    wss?.close();
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}
