/**
 * Dashboard Server - Express + WebSocket server for real-time monitoring
 * 
 * Usage:
 *   import { startDashboard } from './src/dashboard/server.js';
 *   startDashboard(3001);
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { dashboardEmitter } from './state-emitter.js';
import type { WebSocketMessage } from './types.js';
import { loadHistory, getSession, getHistorySummary } from './session-history.js';
import { getSupabaseClient } from '../../modules/shared/supabase-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

// ---------------------------------------------------------------------------
// Paper stats helper types
// ---------------------------------------------------------------------------

interface ModuleStat {
  tradeCount: number;
  totalNetProfitUsd: number;
  avgProfitPerTrade: number;
  lastTradeAt: string | null;
}

/** Sportsbook-arb positions can be open/pending; shape is distinct from settled modules. */
interface SportsbookStat {
  openCount: number;
  wonCount: number;
  lostCount: number;
  settledNetProfitUsd: number;
  /** null when no positions have settled yet (can't compute a meaningful rate). */
  winRate: number | null;
}

function emptyModuleStat(): ModuleStat {
  return { tradeCount: 0, totalNetProfitUsd: 0, avgProfitPerTrade: 0, lastTradeAt: null };
}

function emptySportsbookStat(): SportsbookStat {
  return { openCount: 0, wonCount: 0, lostCount: 0, settledNetProfitUsd: 0, winRate: null };
}

function emptyPaperStats() {
  return {
    byModule: {} as Record<string, ModuleStat | SportsbookStat>,
    total: emptyModuleStat(),
  };
}

/** Page size for paginated paper_trades fetch. Supabase REST caps at 1000/request. */
const PAPER_STATS_PAGE = 1000;

/**
 * Fetch all paper_trades rows (excluding suspect duplicates) using paginated
 * requests to work around Supabase REST's default 1000-row cap.
 *
 * Falls back to fetching without the suspect_duplicate filter if the column
 * doesn't exist yet (migration pending), and logs a warning.
 */
async function fetchAllPaperTrades(db: ReturnType<typeof getSupabaseClient>): Promise<Array<{
  module: string;
  net_profit_usd: string | number | null;
  status: string | null;
  opened_at: string;
}>> {
  const all: Array<{ module: string; net_profit_usd: string | number | null; status: string | null; opened_at: string }> = [];
  let from = 0;
  let useSuspectFilter = true;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('paper_trades')
      .select('module, net_profit_usd, status, opened_at')
      .range(from, from + PAPER_STATS_PAGE - 1);

    if (useSuspectFilter) {
      query = query.eq('suspect_duplicate', false);
    }

    const { data, error } = await query;

    if (error) {
      // If the suspect_duplicate column doesn't exist (migration pending),
      // retry once without the filter so stats still render.
      if (useSuspectFilter && (
        error.message?.includes('suspect_duplicate') ||
        error.message?.includes('column') ||
        (error as { code?: string }).code === '42703'
      )) {
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          source: 'dashboard',
          message: 'paper-stats: suspect_duplicate column missing — migration pending; returning unfiltered totals',
        }));
        useSuspectFilter = false;
        from = 0;
        all.length = 0;
        continue;
      }
      break;  // other error — stop and return what we have
    }

    if (!data || !Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < PAPER_STATS_PAGE) break;  // last page
    from += PAPER_STATS_PAGE;
  }

  return all;
}

async function queryPaperStats() {
  try {
    const db = getSupabaseClient();
    const data = await fetchAllPaperTrades(db);

    if (data.length === 0) return emptyPaperStats();

    const byModule: Record<string, ModuleStat | SportsbookStat> = {};
    const total = emptyModuleStat();

    for (const row of data as Array<{
      module: string;
      net_profit_usd: string | number | null;
      status: string | null;
      opened_at: string;
    }>) {
      const m = row.module;

      if (m === 'sportsbook-arb') {
        // Sportsbook positions have open/won/lost lifecycle; track separately.
        if (!byModule[m]) byModule[m] = emptySportsbookStat();
        const sb = byModule[m] as SportsbookStat;
        const status = row.status ?? 'open';
        if (status === 'open') {
          sb.openCount++;
        } else if (status === 'won') {
          sb.wonCount++;
          sb.settledNetProfitUsd += Number(row.net_profit_usd ?? 0);
        } else if (status === 'lost') {
          sb.lostCount++;
          sb.settledNetProfitUsd += Number(row.net_profit_usd ?? 0);
        }
        const settled = sb.wonCount + sb.lostCount;
        sb.winRate = settled > 0 ? sb.wonCount / settled : null;

        // Only count settled sportsbook trades in the total (open positions have no realised P&L).
        if (status === 'won' || status === 'lost') {
          total.tradeCount++;
          total.totalNetProfitUsd += Number(row.net_profit_usd ?? 0);
          if (!total.lastTradeAt || row.opened_at > total.lastTradeAt) {
            total.lastTradeAt = row.opened_at;
          }
        }
      } else {
        // Risk-free settled modules: net_profit_usd is always non-null.
        if (!byModule[m]) byModule[m] = emptyModuleStat();
        const stat = byModule[m] as ModuleStat;
        const profit = Number(row.net_profit_usd ?? 0);
        stat.tradeCount++;
        stat.totalNetProfitUsd += profit;
        if (!stat.lastTradeAt || row.opened_at > stat.lastTradeAt) {
          stat.lastTradeAt = row.opened_at;
        }
        total.tradeCount++;
        total.totalNetProfitUsd += profit;
        if (!total.lastTradeAt || row.opened_at > total.lastTradeAt) {
          total.lastTradeAt = row.opened_at;
        }
      }
    }

    for (const m of Object.keys(byModule)) {
      if (m !== 'sportsbook-arb') {
        const stat = byModule[m] as ModuleStat;
        stat.avgProfitPerTrade = stat.tradeCount > 0
          ? stat.totalNetProfitUsd / stat.tradeCount
          : 0;
      }
    }
    total.avgProfitPerTrade = total.tradeCount > 0
      ? total.totalNetProfitUsd / total.tradeCount
      : 0;

    return { byModule, total };
  } catch {
    return emptyPaperStats();
  }
}

/** Read the entire request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function broadcast(message: WebSocketMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

export function startDashboard(port = 3001): http.Server {
  server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getFullData()));
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getState()));
      return;
    }

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getConfig()));
      return;
    }

    if (url.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getLogs()));
      return;
    }

    // History API endpoints
    if (url.pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadHistory()));
      return;
    }

    if (url.pathname.startsWith('/api/history/')) {
      const sessionId = url.pathname.replace('/api/history/', '');
      const session = getSession(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (url.pathname === '/api/paper-stats') {
      const stats = await queryPaperStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    // ── PUT /api/config/pair-discovery ────────────────────────────────────────
    // Writes enabled / interval_hours to bot_config table and immediately
    // updates the in-process dashboardEmitter so WebSocket clients see the
    // change without waiting for the next DB poll cycle.
    if (req.method === 'PUT' && url.pathname === '/api/config/pair-discovery') {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read request body' }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: { enabled?: boolean; interval_hours?: number } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { enabled, interval_hours } = parsed;

      if (
        interval_hours !== undefined &&
        (typeof interval_hours !== 'number' || !isFinite(interval_hours) || interval_hours <= 0)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'interval_hours must be a positive number' }));
        return;
      }

      const upserts: Array<{ module: string; key: string; value: string }> = [];
      if (enabled !== undefined) {
        upserts.push({ module: 'pair-discovery', key: 'enabled', value: String(Boolean(enabled)) });
      }
      if (interval_hours !== undefined) {
        upserts.push({ module: 'pair-discovery', key: 'interval_hours', value: String(interval_hours) });
      }

      if (upserts.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields provided (expected: enabled, interval_hours)' }));
        return;
      }

      const db = getSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: dbError } = await (db as any)
        .from('bot_config')
        .upsert(upserts, { onConflict: 'module,key' });

      if (dbError) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: dbError.message }));
        return;
      }

      // Mirror the change into the in-process config so WS clients see it immediately.
      const currentConfig = dashboardEmitter.getConfig();
      if (currentConfig) {
        const existing = currentConfig.pairDiscovery ?? { enabled: false, intervalHours: 6 };
        dashboardEmitter.updateConfig({
          ...currentConfig,
          pairDiscovery: {
            enabled:       enabled      !== undefined ? Boolean(enabled)      : existing.enabled,
            intervalHours: interval_hours !== undefined ? interval_hours : existing.intervalHours,
          },
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Serve static files from dashboard/dist
    // __dirname at runtime = <repo-root>/dist/src/dashboard — three levels up to reach repo root
    const distPath = path.resolve(__dirname, '../../../dashboard/dist');
    let filePath = path.join(distPath, url.pathname === '/' ? 'index.html' : url.pathname);

    // Check if file exists
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback - serve index.html for all other routes
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[Dashboard] Client connected');

    // Send full state on connect
    ws.send(JSON.stringify({
      type: 'full',
      payload: dashboardEmitter.getFullData(),
    } as WebSocketMessage));

    // Handle incoming messages (commands)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'command') {
          console.log(`[Dashboard] Command received: ${message.command}`, message.payload);
          dashboardEmitter.emit('command', { command: message.command, payload: message.payload });
        }
      } catch (e) {
        console.error('[Dashboard] Failed to parse message:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Dashboard] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Dashboard] WebSocket error:', err.message);
    });
  });

  // Subscribe to state changes
  dashboardEmitter.on('state', (state) => {
    broadcast({ type: 'state', payload: state });
  });

  dashboardEmitter.on('log', (entry) => {
    broadcast({ type: 'log', payload: entry });
  });

  dashboardEmitter.on('config', (config) => {
    broadcast({ type: 'config', payload: config });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Dashboard] Server running at http://0.0.0.0:${port}`);
    console.log(`[Dashboard] WebSocket at ws://0.0.0.0:${port}`);
  });

  return server;
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      wss.close();
      wss = null;
    }
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export { dashboardEmitter };
