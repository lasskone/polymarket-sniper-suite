/**
 * bot/health-server.ts — lightweight HTTP health check server.
 *
 * Uses Node's built-in `http` module (no extra dependency).
 *
 * Endpoints:
 *   GET /health  → { status, uptime, modules, tradingMode }
 *   GET /status  → extended state: recent activity counts, circuit breaker
 *   GET /*       → 404
 *
 * Railway uses GET /health with a configurable timeout to decide whether
 * a deployment is healthy.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createLogger } from '../modules/shared/logger.js';

const log = createLogger('health-server');

// ---------------------------------------------------------------------------
// Shared state — pushed in from the orchestrator
// ---------------------------------------------------------------------------

export interface BotStatus {
  activeModules:       string[];
  disabledModules:     string[];
  tradingMode:         'paper' | 'live';
  tradesExecuted:      number;
  opportunitiesFound:  number;
  errors:              number;
  circuitBreakerActive: boolean;
  startedAt:           number;  // Date.now()
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

/** Called by the orchestrator to push live state into the health server. */
export function updateBotStatus(patch: Partial<BotStatus>): void {
  Object.assign(state, patch);
}

export function incrementTrades(): void     { state.tradesExecuted++; }
export function incrementOpportunities(): void { state.opportunitiesFound++; }
export function incrementErrors(): void     { state.errors++; }

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';

  if (req.method !== 'GET') {
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (url === '/health' || url === '/health/') {
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    respond(res, 200, {
      status:       'ok',
      uptime:       uptimeSec,
      modules:      state.activeModules,
      tradingMode:  state.tradingMode,
    });
    return;
  }

  if (url === '/status' || url === '/status/') {
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    respond(res, 200, {
      status:              'ok',
      uptime:              uptimeSec,
      startedAt:           new Date(state.startedAt).toISOString(),
      tradingMode:         state.tradingMode,
      activeModules:       state.activeModules,
      disabledModules:     state.disabledModules,
      tradesExecuted:      state.tradesExecuted,
      opportunitiesFound:  state.opportunitiesFound,
      errors:              state.errors,
      circuitBreakerActive: state.circuitBreakerActive,
    });
    return;
  }

  respond(res, 404, { error: 'Not Found', path: url });
}

function respond(res: ServerResponse, code: number, body: object): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer> | null = null;

export function startHealthServer(port: number): void {
  server = createServer(handleRequest);

  server.on('error', (err) => {
    log.error('Health server error', { error: String(err) });
  });

  server.listen(port, () => {
    log.info('Health server listening', { port, endpoints: ['/health', '/status'] });
  });
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}
