/**
 * EventDetector — API-Football v3 client for the latency-sniper module.
 *
 * Responsibilities:
 *   - Poll live matches every N seconds
 *   - Detect NEW events by diffing against last known state
 *   - Respect rate limits (free tier: 100 req/day, 10 req/min)
 *   - Exponential backoff on 429
 *   - Cache responses to minimise API calls
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { createLogger } from '../shared/logger.js';
import type { LatencySniperConfig } from './config.js';

const log = createLogger('event-detector');

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Team {
  id: number;
  name: string;
  logo: string;
}

export interface Player {
  id: number | null;
  name: string | null;
}

export interface Event {
  time: number;          // minute elapsed
  type: string;          // 'Goal' | 'Card' | 'Var' | 'Substitution'
  detail: string;        // 'Normal Goal' | 'Red Card' | 'Penalty' | …
  team: Team;
  player: Player;
  assist?: Player;
}

export interface Match {
  fixtureId: number;
  league: string;
  homeTeam: Team;
  awayTeam: Team;
  status: string;        // '1H' | 'HT' | '2H' | 'ET' | 'P' | 'FT'
  minute: number;
  score: { home: number; away: number };
  events: Event[];
  lastUpdate: number;    // Date.now()
}

export interface NewEvent {
  match: Match;
  event: Event;
  detectedAt: number;    // Date.now()
}

// ---------------------------------------------------------------------------
// Raw API-Football response shapes
// ---------------------------------------------------------------------------

interface ApiFixture {
  fixture: {
    id: number;
    status: { short: string; elapsed: number | null };
    venue: { name: string | null };
  };
  league: { name: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
}

interface ApiEvent {
  time: { elapsed: number; extra: number | null };
  team: { id: number; name: string; logo: string };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Rate-limit tracker
// ---------------------------------------------------------------------------

class RateLimiter {
  private callTimestamps: number[] = [];
  private readonly windowMs = 60_000;

  constructor(private readonly maxPerMinute: number) {}

  /**
   * Returns ms to wait before the next call is safe, 0 if OK now.
   */
  waitMs(): number {
    const now = Date.now();
    // Purge timestamps outside the window
    this.callTimestamps = this.callTimestamps.filter(
      (t) => now - t < this.windowMs,
    );

    if (this.callTimestamps.length >= this.maxPerMinute) {
      const oldest = this.callTimestamps[0];
      return this.windowMs - (now - oldest) + 50; // +50ms buffer
    }
    return 0;
  }

  record(): void {
    this.callTimestamps.push(Date.now());
  }

  get callsThisMinute(): number {
    const now = Date.now();
    return this.callTimestamps.filter((t) => now - t < this.windowMs).length;
  }
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class ResponseCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }
}

// ---------------------------------------------------------------------------
// Active statuses — only poll events for matches in these states
// ---------------------------------------------------------------------------
const ACTIVE_STATUSES = new Set(['1H', '2H', 'ET', 'P', 'BT']);
const LIVE_STATUSES   = new Set(['1H', 'HT', '2H', 'ET', 'P', 'BT', 'LIVE']);

// ---------------------------------------------------------------------------
// EventDetector
// ---------------------------------------------------------------------------

export class EventDetector {
  private readonly http: AxiosInstance;
  private readonly rateLimiter: RateLimiter;
  private readonly cache = new ResponseCache();

  /** fixture_id → last known match state */
  private readonly matchState = new Map<number, Match>();

  constructor(private readonly config: LatencySniperConfig) {
    this.http = axios.create({
      baseURL: 'https://v3.football.api-sports.io',
      headers: { 'x-apisports-key': config.apiFootballKey },
      timeout: 10_000,
    });

    this.rateLimiter = new RateLimiter(config.maxApiCallsPerMinute);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetches all currently live matches.
   * Cached for 30 seconds to avoid hammering the endpoint.
   */
  async getLiveMatches(): Promise<Match[]> {
    const cacheKey = 'live-matches';
    const cached = this.cache.get<Match[]>(cacheKey);
    if (cached) {
      log.debug('getLiveMatches: cache hit', { count: cached.length });
      return cached;
    }

    const raw = await this.apiGet<{ response: ApiFixture[] }>('/fixtures?live=all');
    if (!raw) return [];

    const matches = raw.response
      .filter((f) => LIVE_STATUSES.has(f.fixture.status.short))
      .filter((f) => this.config.targetLeagues.includes(f.league.name))
      .map((f) => this.mapFixture(f));

    this.cache.set(cacheKey, matches, 30_000);
    log.debug('getLiveMatches: fetched', {
      total: raw.response.length,
      filtered: matches.length,
      leagues: [...new Set(matches.map((m) => m.league))],
    });
    return matches;
  }

  /**
   * Fetches events for a single fixture.
   * Cached for 10 seconds.
   */
  async getMatchEvents(fixtureId: number): Promise<Event[]> {
    const cacheKey = `events-${fixtureId}`;
    const cached = this.cache.get<Event[]>(cacheKey);
    if (cached) return cached;

    const raw = await this.apiGet<{ response: ApiEvent[] }>(
      `/fixtures/events?fixture=${fixtureId}`,
    );
    if (!raw) return [];

    const events = raw.response
      .filter((e) => this.config.targetEventTypes.includes(e.type))
      .map((e) => this.mapEvent(e));

    this.cache.set(cacheKey, events, 10_000);
    return events;
  }

  /**
   * Main polling method. Call on each tick of the sniper loop.
   *
   * Returns only matches that have at least one NEW event since the
   * last call, with `match.events` containing ONLY the new events.
   */
  async pollLiveMatches(): Promise<NewEvent[]> {
    const matches = await this.getLiveMatches();
    if (matches.length === 0) {
      log.debug('No live matches in target leagues');
      return [];
    }

    const enriched: Match[] = [];
    for (const match of matches) {
      if (!ACTIVE_STATUSES.has(match.status)) {
        enriched.push({ ...match, events: [] });
        continue;
      }

      const events = await this.getMatchEvents(match.fixtureId);
      enriched.push({ ...match, events, lastUpdate: Date.now() });
    }

    const newEvents = this.detectNewEvents(enriched, this.matchState);

    // Update state
    for (const match of enriched) {
      this.matchState.set(match.fixtureId, match);
    }

    if (newEvents.length > 0) {
      log.info('New events detected', {
        count: newEvents.length,
        events: newEvents.map((ne) => ({
          fixture: ne.match.fixtureId,
          league: ne.match.league,
          type: ne.event.type,
          detail: ne.event.detail,
          team: ne.event.team.name,
          minute: ne.event.time,
          score: ne.match.score,
        })),
      });
    }

    // Rate-limit warning
    const calls = this.rateLimiter.callsThisMinute;
    if (calls >= Math.floor(this.config.maxApiCallsPerMinute * 0.8)) {
      log.warn('Approaching rate limit', {
        callsThisMinute: calls,
        maxPerMinute: this.config.maxApiCallsPerMinute,
      });
    }

    return newEvents;
  }

  /**
   * Compares current matches against the previously stored state and
   * returns only genuinely new events (not seen in the previous poll).
   */
  detectNewEvents(
    currentMatches: Match[],
    previousState: Map<number, Match>,
  ): NewEvent[] {
    const newEvents: NewEvent[] = [];
    const now = Date.now();

    for (const match of currentMatches) {
      const prev = previousState.get(match.fixtureId);

      for (const event of match.events) {
        // An event is "new" if:
        //  a) we've never seen this fixture before, OR
        //  b) the event minute is greater than the last known event minute, OR
        //  c) same minute but the detail is new (e.g., two goals in one minute)
        const isNew =
          !prev ||
          prev.events.length === 0 ||
          !prev.events.some(
            (pe) => pe.time === event.time &&
                    pe.type === event.type &&
                    pe.detail === event.detail &&
                    pe.team.id === event.team.id,
          );

        if (isNew) {
          newEvents.push({ match, event, detectedAt: now });
        }
      }
    }

    return newEvents;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Thin HTTP wrapper with rate-limiting, retry on 429, and error handling.
   * Returns null on any unrecoverable error so callers can return [].
   */
  private async apiGet<T>(
    path: string,
    retries = 3,
    delayMs = 1_000,
  ): Promise<T | null> {
    // Wait if we're at the rate limit
    const waitMs = this.rateLimiter.waitMs();
    if (waitMs > 0) {
      log.debug('Rate limit pause', { waitMs, path });
      await sleep(waitMs);
    }

    try {
      this.rateLimiter.record();
      const { data } = await this.http.get<T>(path);
      return data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;

      if (status === 429 && retries > 0) {
        const backoff = delayMs * 2;
        log.warn('429 rate limit hit, backing off', { path, backoff, retriesLeft: retries - 1 });
        await sleep(backoff);
        return this.apiGet<T>(path, retries - 1, backoff);
      }

      if (status === 401 || status === 403) {
        log.error('API-Football auth error — check API_FOOTBALL_KEY', { status, path });
        return null;
      }

      log.error('API-Football request failed', {
        path,
        status,
        message: axiosErr.message,
      });
      return null;
    }
  }

  private mapFixture(f: ApiFixture): Match {
    return {
      fixtureId: f.fixture.id,
      league: f.league.name,
      homeTeam: {
        id: f.teams.home.id,
        name: f.teams.home.name,
        logo: f.teams.home.logo,
      },
      awayTeam: {
        id: f.teams.away.id,
        name: f.teams.away.name,
        logo: f.teams.away.logo,
      },
      status: f.fixture.status.short,
      minute: f.fixture.status.elapsed ?? 0,
      score: {
        home: f.goals.home ?? 0,
        away: f.goals.away ?? 0,
      },
      events: [],
      lastUpdate: Date.now(),
    };
  }

  private mapEvent(e: ApiEvent): Event {
    return {
      time: e.time.elapsed + (e.time.extra ?? 0),
      type: e.type,
      detail: e.detail,
      team: { id: e.team.id, name: e.team.name, logo: e.team.logo },
      player: { id: e.player.id, name: e.player.name },
      ...(e.assist?.name ? { assist: { id: e.assist.id, name: e.assist.name } } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
