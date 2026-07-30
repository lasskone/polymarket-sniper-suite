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
import { logicArbTradeLegs, logicArbDeviation } from '../services/logic-arb-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

// ---------------------------------------------------------------------------
// Gamma slug cache — avoid hammering the API on every dashboard load
// ---------------------------------------------------------------------------

const SLUG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
type SlugStatus = 'open' | 'closed' | 'not_found';
const slugCache = new Map<string, { result: SlugStatus; ts: number }>();

async function checkSlug(slug: string): Promise<SlugStatus> {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.ts < SLUG_CACHE_TTL_MS) return cached.result;

  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`
    );
    if (!res.ok) {
      const result: SlugStatus = 'not_found';
      slugCache.set(slug, { result, ts: Date.now() });
      return result;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = await res.json() as any[];
    const result: SlugStatus =
      !markets || markets.length === 0
        ? 'not_found'
        : markets[0].closed === true
          ? 'closed'
          : 'open';
    slugCache.set(slug, { result, ts: Date.now() });
    return result;
  } catch {
    // Network error — don't cache, treat as open to avoid false expiry
    return 'open';
  }
}

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

// ---------------------------------------------------------------------------
// Trades history types + helpers
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  module: string;
  market_label: string;
  net_profit_usd: string | number | null;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  entry_price: string | number | null;
  shares: string | number;
}

interface TradeStats {
  totalCount: number;
  totalSettledPnl: number;
  openCount: number;
  byModule: Record<string, { count: number; settledPnl: number; openCount: number }>;
}

function computeTradeStats(trades: TradeRow[]): TradeStats {
  const byModule: Record<string, { count: number; settledPnl: number; openCount: number }> = {};
  let totalSettledPnl = 0;
  let openCount = 0;

  for (const t of trades) {
    if (!byModule[t.module]) byModule[t.module] = { count: 0, settledPnl: 0, openCount: 0 };
    byModule[t.module].count++;
    if (t.status === 'open') {
      byModule[t.module].openCount++;
      openCount++;
    } else if (t.net_profit_usd != null) {
      const pnl = Number(t.net_profit_usd);
      byModule[t.module].settledPnl += pnl;
      totalSettledPnl += pnl;
    }
  }

  return { totalCount: trades.length, totalSettledPnl, openCount, byModule };
}

async function fetchTradesHistory(module?: string): Promise<{ trades: TradeRow[]; total: number; stats: TradeStats }> {
  const all: TradeRow[] = [];
  let from = 0;
  let useSuspectFilter = true;
  const db = getSupabaseClient();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('paper_trades')
      .select('id, module, market_label, net_profit_usd, status, opened_at, resolved_at, entry_price, shares')
      .order('opened_at', { ascending: false })
      .range(from, from + PAPER_STATS_PAGE - 1);

    if (module) {
      query = query.eq('module', module);
    }

    if (useSuspectFilter) {
      query = query.eq('suspect_duplicate', false);
    }

    const { data, error } = await query;

    if (error) {
      if (
        useSuspectFilter && (
          error.message?.includes('suspect_duplicate') ||
          error.message?.includes('column') ||
          (error as { code?: string }).code === '42703'
        )
      ) {
        useSuspectFilter = false;
        from = 0;
        all.length = 0;
        continue;
      }
      break;
    }

    if (!data || !Array.isArray(data) || data.length === 0) break;
    all.push(...(data as TradeRow[]));
    if (data.length < PAPER_STATS_PAGE) break;
    from += PAPER_STATS_PAGE;
  }

  return { trades: all, total: all.length, stats: computeTradeStats(all) };
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

    // ── GET /api/trades ───────────────────────────────────────────────────────
    // Returns all paper_trades rows (newest first) with pagination behind the
    // scenes to bypass Supabase REST's 1000-row cap.  Includes computed stats.
    if (req.method === 'GET' && url.pathname === '/api/trades') {
      try {
        const moduleFilter = url.searchParams.get('module') ?? undefined;
        const result = await fetchTradesHistory(moduleFilter);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch trades' }));
      }
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

    // ── GET /api/logic-arb/pairs ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/logic-arb/pairs') {
      const db = getSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('correlated_market_pairs')
        .select('id, market_a_slug, market_b_slug, market_a_condition_id, market_b_condition_id, relationship, notes, active, created_at')
        .order('active', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data ?? []));
      return;
    }

    // ── GET /api/logic-arb/suggestions ───────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/logic-arb/suggestions') {
      const statusParam = url.searchParams.get('status') ?? 'pending';
      const db = getSupabaseClient();

      // For 'expired', just return the stored expired rows — no slug-checking needed.
      if (statusParam === 'expired') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (db as any)
          .from('correlated_pair_suggestions')
          .select('id, market_a_slug, market_b_slug, market_a_question, market_b_question, market_a_condition_id, market_b_condition_id, relationship, confidence, reasoning, status, created_at')
          .eq('status', 'expired')
          .order('created_at', { ascending: false });
        if (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data ?? []));
        return;
      }

      // For 'pending' (default): fetch all pending, batch-check slugs via Gamma,
      // mark closed/delisted ones as 'expired', return only the live ones.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('correlated_pair_suggestions')
        .select('id, market_a_slug, market_b_slug, market_a_question, market_b_question, market_a_condition_id, market_b_condition_id, relationship, confidence, reasoning, status, created_at')
        .eq('status', 'pending')
        .order('confidence', { ascending: false });
      if (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }

      const rows: Array<{
        id: string;
        market_a_slug: string;
        market_b_slug: string;
        [key: string]: unknown;
      }> = data ?? [];

      if (rows.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }

      // Collect unique slugs to check
      const uniqueSlugs = [...new Set(rows.flatMap(r => [r.market_a_slug, r.market_b_slug]))];
      // Check slugs concurrently (cache keeps this fast on repeated calls)
      const slugResults = await Promise.all(uniqueSlugs.map(async s => [s, await checkSlug(s)] as const));
      const slugStatusMap = new Map<string, SlugStatus>(slugResults);

      // Partition: expired if either market is closed or not_found
      const expiredIds: string[] = [];
      const liveRows: typeof rows = [];
      for (const row of rows) {
        const aStatus = slugStatusMap.get(row.market_a_slug) ?? 'open';
        const bStatus = slugStatusMap.get(row.market_b_slug) ?? 'open';
        if (aStatus !== 'open' || bStatus !== 'open') {
          expiredIds.push(row.id);
        } else {
          liveRows.push(row);
        }
      }

      // Mark expired in DB (best-effort — ignore if 'expired' not yet in constraint)
      if (expiredIds.length > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (db as any)
            .from('correlated_pair_suggestions')
            .update({ status: 'expired' })
            .in('id', expiredIds);
        } catch {
          // Migration not yet applied — expired suggestions stay pending but are
          // still excluded from the response so the queue stays clean.
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveRows));
      return;
    }

    // ── GET /api/logic-arb/config ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/logic-arb/config') {
      const db = getSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (db as any)
        .from('bot_config')
        .select('key, value')
        .eq('module', 'logic-arb');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kv = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        cooldownMs:              Number(kv['cooldown_ms']                ?? 1_800_000),
        minNetProfitUSD:         Number(kv['min_net_profit_usd']         ?? 0.05),
        deadPairNullThreshold:   Number(kv['dead_pair_null_threshold']   ?? 5),
        deadPairClosedThreshold: Number(kv['dead_pair_closed_threshold'] ?? 1),
      }));
      return;
    }

    // ── PUT /api/logic-arb/config ─────────────────────────────────────────────
    if (req.method === 'PUT' && url.pathname === '/api/logic-arb/config') {
      let body: string;
      try { body = await readBody(req); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read request body' }));
        return;
      }
      let parsed: { cooldownMs?: number; minNetProfitUSD?: number; deadPairNullThreshold?: number; deadPairClosedThreshold?: number } = {};
      try { parsed = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const upserts: Array<{ module: string; key: string; value: string }> = [];
      if (parsed.cooldownMs !== undefined && parsed.cooldownMs > 0)
        upserts.push({ module: 'logic-arb', key: 'cooldown_ms', value: String(parsed.cooldownMs) });
      if (parsed.minNetProfitUSD !== undefined && parsed.minNetProfitUSD >= 0)
        upserts.push({ module: 'logic-arb', key: 'min_net_profit_usd', value: String(parsed.minNetProfitUSD) });
      if (parsed.deadPairNullThreshold !== undefined && parsed.deadPairNullThreshold > 0)
        upserts.push({ module: 'logic-arb', key: 'dead_pair_null_threshold', value: String(parsed.deadPairNullThreshold) });
      if (parsed.deadPairClosedThreshold !== undefined && parsed.deadPairClosedThreshold > 0)
        upserts.push({ module: 'logic-arb', key: 'dead_pair_closed_threshold', value: String(parsed.deadPairClosedThreshold) });
      if (upserts.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields provided' }));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── PUT /api/pair-suggestions/:id/approve ─────────────────────────────────
    {
      const approveMatch = url.pathname.match(/^\/api\/pair-suggestions\/([^/]+)\/approve$/);
      if (req.method === 'PUT' && approveMatch) {
        const id = approveMatch[1];
        const db = getSupabaseClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: suggestion, error: fetchErr } = await (db as any)
          .from('correlated_pair_suggestions')
          .select('market_a_condition_id, market_b_condition_id, market_a_slug, market_b_slug, relationship, reasoning')
          .eq('id', id)
          .eq('status', 'pending')
          .single();
        if (fetchErr || !suggestion) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Suggestion not found or not pending' }));
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insertErr } = await (db as any)
          .from('correlated_market_pairs')
          .insert({
            market_a_condition_id: suggestion.market_a_condition_id,
            market_b_condition_id: suggestion.market_b_condition_id,
            market_a_slug:         suggestion.market_a_slug,
            market_b_slug:         suggestion.market_b_slug,
            relationship:          suggestion.relationship,
            notes:                 suggestion.reasoning,
            active:                true,
          });
        const alreadyExists = insertErr?.code === '23505';
        if (insertErr && !alreadyExists) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: insertErr.message }));
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any)
          .from('correlated_pair_suggestions')
          .update({ status: 'approved' })
          .eq('id', id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, alreadyExists }));
        return;
      }
    }

    // ── PUT /api/pair-suggestions/:id/reject ──────────────────────────────────
    {
      const rejectMatch = url.pathname.match(/^\/api\/pair-suggestions\/([^/]+)\/reject$/);
      if (req.method === 'PUT' && rejectMatch) {
        const id = rejectMatch[1];
        const db = getSupabaseClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (db as any)
          .from('correlated_pair_suggestions')
          .update({ status: 'rejected' })
          .eq('id', id)
          .eq('status', 'pending');
        if (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // ── GET /api/logic-arb/trades/detailed ───────────────────────────────────
    // Returns every non-suspect logic-arb paper_trade with per-leg breakdown
    // (side bought, market slug, fill price, $ notional) derived from the same
    // logicArbTradeLegs / logicArbDeviation pure functions used elsewhere,
    // plus a grouped summary by market pair with avg stats.
    if (req.method === 'GET' && url.pathname === '/api/logic-arb/trades/detailed') {
      try {
        const db = getSupabaseClient();
        const PAGE   = 1000;
        const SHARES = 10;

        type RawRow = {
          id:             string;
          opened_at:      string;
          market_label:   string;
          net_profit_usd: string | number | null;
          metadata:       Record<string, unknown> | null;
        };

        const allRows: RawRow[] = [];
        let from            = 0;
        let useSuspectFilter = true;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let q = (db as any)
            .from('paper_trades')
            .select('id, opened_at, market_label, net_profit_usd, metadata')
            .eq('module', 'logic-arb')
            .order('opened_at', { ascending: false })
            .range(from, from + PAGE - 1);

          if (useSuspectFilter) q = q.eq('suspect_duplicate', false);

          const { data, error } = await q;

          if (error) {
            if (
              useSuspectFilter && (
                (error as { message?: string }).message?.includes('suspect_duplicate') ||
                (error as { code?: string }).code === '42703'
              )
            ) {
              useSuspectFilter = false;
              from = 0;
              allRows.length = 0;
              continue;
            }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (error as { message?: string }).message ?? 'DB error' }));
            return;
          }

          if (!data || !Array.isArray(data) || data.length === 0) break;
          allRows.push(...(data as RawRow[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }

        type DetailedTrade = {
          id:              string;
          opened_at:       string;
          market_pair_label: string;
          relationship:    string;
          priceA:          number;
          priceB:          number;
          legA: { token: string; action: string; marketSlug: string; fillPrice: number; notionalUsd: number };
          legB: { token: string; action: string; marketSlug: string; fillPrice: number; notionalUsd: number };
          totalInvestedUsd: number;
          deviation:        number;
          deviationPct:     number;
          feeRate:          number;
          netProfitUsd:     number;
          shares:           number;
        };

        type PairAgg = {
          marketPairLabel: string;
          count:           number;
          totalDev:        number;
          totalInvested:   number;
          totalProfit:     number;
          relationships:   Set<string>;
        };

        const trades: DetailedTrade[] = [];
        const pairMap = new Map<string, PairAgg>();

        for (const row of allRows) {
          const meta = row.metadata as {
            relationship?: string;
            priceA?:       number;
            priceB?:       number;
            deviation?:    number;
            feeRate?:      number;
            netProfitUSD?: number;
            marketASlug?:  string;
            marketBSlug?:  string;
          } | null;

          if (!meta || typeof meta.priceA !== 'number' || typeof meta.priceB !== 'number') continue;

          const relationship = (meta.relationship ?? 'mutually_exclusive') as 'a_implies_b' | 'mutually_exclusive';
          const priceA  = meta.priceA;
          const priceB  = meta.priceB;
          const feeRate = typeof meta.feeRate === 'number' ? meta.feeRate : 0.04;

          const legs = logicArbTradeLegs(relationship, priceA, priceB);
          const deviation = typeof meta.deviation === 'number'
            ? meta.deviation
            : logicArbDeviation(relationship, priceA, priceB);

          const legAFill     = legs.legA.price;
          const legBFill     = legs.legB.price;
          const legANotional = SHARES * legAFill;
          const legBNotional = SHARES * legBFill;
          const totalInvested = legANotional + legBNotional;
          const netProfit    = Number(row.net_profit_usd ?? meta.netProfitUSD ?? 0);

          trades.push({
            id:               row.id,
            opened_at:        row.opened_at,
            market_pair_label: row.market_label,
            relationship,
            priceA,
            priceB,
            legA: {
              token:      legs.legA.token,
              action:     `Buy ${legs.legA.token} on Market A`,
              marketSlug: meta.marketASlug ?? '',
              fillPrice:  legAFill,
              notionalUsd: legANotional,
            },
            legB: {
              token:      legs.legB.token,
              action:     `Buy ${legs.legB.token} on Market B`,
              marketSlug: meta.marketBSlug ?? '',
              fillPrice:  legBFill,
              notionalUsd: legBNotional,
            },
            totalInvestedUsd: totalInvested,
            deviation,
            deviationPct:     deviation * 100,
            feeRate,
            netProfitUsd:     netProfit,
            shares:           SHARES,
          });

          const agg = pairMap.get(row.market_label) ?? {
            marketPairLabel: row.market_label,
            count:           0,
            totalDev:        0,
            totalInvested:   0,
            totalProfit:     0,
            relationships:   new Set<string>(),
          };
          agg.count++;
          agg.totalDev      += deviation;
          agg.totalInvested += totalInvested;
          agg.totalProfit   += netProfit;
          agg.relationships.add(relationship);
          pairMap.set(row.market_label, agg);
        }

        const summary = Array.from(pairMap.values()).map(s => ({
          marketPairLabel: s.marketPairLabel,
          count:           s.count,
          relationship:    s.relationships.size > 1
            ? 'mixed'
            : (Array.from(s.relationships)[0] ?? ''),
          avgDeviationPct: (s.totalDev      / s.count) * 100,
          avgInvestedUsd:   s.totalInvested  / s.count,
          avgProfitUsd:     s.totalProfit    / s.count,
          totalProfitUsd:   s.totalProfit,
        })).sort((a, b) => b.count - a.count);

        const grandCount    = trades.length;
        const grandProfit   = trades.reduce((s, t) => s + t.netProfitUsd,     0);
        const grandInvested = trades.reduce((s, t) => s + t.totalInvestedUsd, 0);
        const grandDev      = trades.reduce((s, t) => s + t.deviation,        0);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          trades,
          summary,
          totals: {
            count:           grandCount,
            totalProfitUsd:  grandProfit,
            totalInvestedUsd: grandInvested,
            avgDeviationPct: grandCount > 0 ? (grandDev / grandCount) * 100 : 0,
            avgProfitUsd:    grandCount > 0 ? grandProfit / grandCount : 0,
          },
        }));
      } catch (err) {
        console.error('[Dashboard] /api/logic-arb/trades/detailed error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
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
