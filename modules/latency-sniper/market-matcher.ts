/**
 * MarketMatcher — finds Polymarket markets that correspond to a live
 * football NewEvent so the sniper can evaluate a trade.
 *
 * Flow:
 *   getActiveMarkets()           → fetch + cache Gamma API
 *   findMatchingMarket(event)    → score each market, return best
 *   estimatePriceImpact(event)   → delegate to pricing util
 */

import axios from 'axios';
import { createLogger } from '../shared/logger.js';
import type { NewEvent } from './event-detector.js';

const log = createLogger('market-matcher');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PolymarketMarket {
  id: string;
  conditionId: string;         // CLOB condition ID for order placement
  question: string;
  slug: string;
  outcomes: string[];          // e.g. ["Yes","No"]
  outcomePrices: string[];     // e.g. ["0.65","0.35"]  — parallel to outcomes
  volume: number;
  liquidity: number;
  endDate: string;
  tags: string[];
  description: string;
}

export interface MatchResult {
  market: PolymarketMarket;
  relevanceScore: number;       // 0–100
  side: 'YES' | 'NO';           // which outcome to buy
  currentPrice: number;         // price for that outcome (0–1)
}

// ---------------------------------------------------------------------------
// Team-name alias map
// Common variations that Polymarket question text may use
// ---------------------------------------------------------------------------

const TEAM_ALIASES: Record<string, string[]> = {
  'Manchester United': ['Man United', 'Man Utd', 'Manchester Utd', 'MUFC', 'Man U'],
  'Manchester City':   ['Man City', 'MCFC', 'City'],
  'Bayern Munich':     ['Bayern', 'Bayern München', 'Bayern Munchen', 'FCB'],
  'Paris Saint-Germain': ['PSG', 'Paris SG', 'Paris Saint Germain'],
  'Borussia Dortmund': ['BVB', 'Dortmund'],
  'Atletico Madrid':   ['Atletico', 'Atlético Madrid', 'Atlético'],
  'Real Madrid':       ['Real', 'RM'],
  'AC Milan':          ['Milan'],
  'Inter Milan':       ['Inter', 'Internazionale'],
  'Newcastle United':  ['Newcastle', 'NUFC'],
  'Tottenham Hotspur': ['Spurs', 'Tottenham'],
  'West Ham United':   ['West Ham'],
  'Nottingham Forest': ['Forest', "Nott'm Forest"],
  'RB Leipzig':        ['Leipzig', 'Red Bull Leipzig'],
  'Bayer Leverkusen':  ['Leverkusen'],
};

// Build reverse index: alias → canonical
const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  markets: PolymarketMarket[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// MarketMatcher
// ---------------------------------------------------------------------------

export class MarketMatcher {
  private readonly http = axios.create({
    baseURL: 'https://gamma-api.polymarket.com',
    timeout: 15_000,
  });

  private cache: CacheEntry | null = null;
  private readonly CACHE_TTL_MS = 5 * 60_000;  // 5 min

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetches all active sports/soccer markets from Gamma API.
   * Cached for 5 minutes.
   */
  async getActiveMarkets(): Promise<PolymarketMarket[]> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      log.debug('getActiveMarkets: cache hit', { count: this.cache.markets.length });
      return this.cache.markets;
    }

    log.debug('getActiveMarkets: fetching from Gamma API');

    try {
      // Fetch in pages — Gamma API returns up to 100 per call
      const markets: PolymarketMarket[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const { data } = await this.http.get<GammaMarket[]>('/markets', {
          params: {
            active: true,
            closed: false,
            limit,
            offset,
          },
        });

        if (!Array.isArray(data) || data.length === 0) break;

        const mapped = data
          .filter((m) => this.isSoccerMarket(m))
          .map((m) => this.mapMarket(m));

        markets.push(...mapped);

        if (data.length < limit) break;   // last page
        offset += limit;

        // Stay polite — brief pause between pages
        await sleep(200);
      }

      // Sort by volume descending so top matches bubble up
      markets.sort((a, b) => b.volume - a.volume);

      this.cache = { markets, expiresAt: Date.now() + this.CACHE_TTL_MS };
      log.info('getActiveMarkets: fetched and cached', { count: markets.length });
      return markets;

    } catch (err) {
      log.error('getActiveMarkets: Gamma API error', { error: String(err) });
      return this.cache?.markets ?? [];  // serve stale cache on error
    }
  }

  /**
   * Finds the best-matching Polymarket market for a given NewEvent.
   * Returns null if no market scores above a minimum threshold (30).
   */
  async findMatchingMarket(ne: NewEvent): Promise<MatchResult | null> {
    const markets = await this.getActiveMarkets();
    if (markets.length === 0) {
      log.debug('findMatchingMarket: no active markets available');
      return null;
    }

    const { homeTeam, awayTeam } = this.extractTeamsFromEvent(ne);

    let best: { market: PolymarketMarket; score: number } | null = null;

    for (const market of markets) {
      const score = this.calculateMarketRelevance(market, ne, homeTeam, awayTeam);
      if (score > 0 && (best === null || score > best.score)) {
        best = { market, score };
      }
    }

    const MIN_SCORE = 30;
    if (!best || best.score < MIN_SCORE) {
      log.debug('findMatchingMarket: no market above threshold', {
        homeTeam, awayTeam,
        league: ne.match.league,
        bestScore: best?.score ?? 0,
        threshold: MIN_SCORE,
      });
      return null;
    }

    // Determine which outcome side to buy
    const side = this.determineSide(best.market, ne, homeTeam);
    const currentPrice = this.getOutcomePrice(best.market, side);

    log.info('findMatchingMarket: match found', {
      question: best.market.question,
      score: best.score,
      side,
      currentPrice,
    });

    return { market: best.market, relevanceScore: best.score, side, currentPrice };
  }

  /**
   * Extracts canonical team names from the event's match.
   */
  extractTeamsFromEvent(ne: NewEvent): { homeTeam: string; awayTeam: string } {
    return {
      homeTeam: this.canonicalize(ne.match.homeTeam.name),
      awayTeam: this.canonicalize(ne.match.awayTeam.name),
    };
  }

  /**
   * Scores a market 0–100 against a given football event.
   *
   * Breakdown:
   *   40 pts — team name(s) appear in question
   *   30 pts — league tag matches
   *   20 pts — end date is close to today (≤ 7 days)
   *   10 pts — volume / liquidity above threshold
   */
  calculateMarketRelevance(
    market: PolymarketMarket,
    ne: NewEvent,
    homeTeam: string,
    awayTeam: string,
  ): number {
    let score = 0;
    const q = market.question.toLowerCase();
    const desc = market.description?.toLowerCase() ?? '';
    const text = `${q} ${desc}`;

    // ── Team name matching (40 pts) ──────────────────────────────────────────
    const homeVariants  = this.getVariants(homeTeam);
    const awayVariants  = this.getVariants(awayTeam);
    const eventTeam     = this.canonicalize(ne.event.team.name);
    const eventVariants = this.getVariants(eventTeam);

    const homeHit  = homeVariants.some((v)  => text.includes(v.toLowerCase()));
    const awayHit  = awayVariants.some((v)  => text.includes(v.toLowerCase()));
    const eventHit = eventVariants.some((v) => text.includes(v.toLowerCase()));

    if (homeHit && awayHit) score += 40;       // both teams mentioned — strong
    else if (eventHit)      score += 25;       // scoring/event team mentioned
    else if (homeHit || awayHit) score += 15;  // one team mentioned

    if (score === 0) return 0;  // no team signal at all — skip rest

    // ── League matching (30 pts) ─────────────────────────────────────────────
    const leagueLower = ne.match.league.toLowerCase();
    const tagHit = market.tags.some((t) => t.toLowerCase().includes(leagueLower) ||
                                           leagueLower.includes(t.toLowerCase()));
    const textHit = text.includes(leagueLower);
    if (tagHit)  score += 30;
    else if (textHit) score += 15;

    // ── Date proximity (20 pts) ───────────────────────────────────────────────
    if (market.endDate) {
      const daysUntilEnd = (new Date(market.endDate).getTime() - Date.now()) / 86_400_000;
      if (daysUntilEnd >= 0 && daysUntilEnd <= 1)       score += 20;
      else if (daysUntilEnd > 1 && daysUntilEnd <= 3)   score += 15;
      else if (daysUntilEnd > 3 && daysUntilEnd <= 7)   score += 10;
      else if (daysUntilEnd > 7 && daysUntilEnd <= 30)  score += 5;
    }

    // ── Volume / liquidity (10 pts) ───────────────────────────────────────────
    if (market.liquidity >= 10_000)     score += 10;
    else if (market.liquidity >= 1_000) score += 5;
    else if (market.liquidity >= 100)   score += 2;

    return Math.min(100, score);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Returns canonical name if known, else the original. */
  private canonicalize(name: string): string {
    return ALIAS_TO_CANONICAL.get(name.toLowerCase()) ?? name;
  }

  /** Returns all known variants for a team name (canonical + aliases). */
  private getVariants(name: string): string[] {
    const canonical = this.canonicalize(name);
    const aliases = TEAM_ALIASES[canonical] ?? [];
    return [canonical, ...aliases, name];  // include original in case it's not in the map
  }

  /**
   * Determines which outcome side benefits from this event.
   * If the event team is the home team (or the question asks about them
   * winning), we buy YES; otherwise NO.
   */
  private determineSide(
    market: PolymarketMarket,
    ne: NewEvent,
    homeTeam: string,
  ): 'YES' | 'NO' {
    const q = market.question.toLowerCase();
    const eventTeam = this.canonicalize(ne.event.team.name);
    const eventVariants = this.getVariants(eventTeam);

    const detail = ne.event.detail.toLowerCase();
    const isNegativeEvent =
      detail.includes('red card') ||
      detail.includes('missed penalty') ||
      detail.includes('own goal');

    // Does the question ask about the event team winning/scoring?
    const questionAboutEventTeam = eventVariants.some((v) =>
      q.includes(v.toLowerCase()),
    );

    if (questionAboutEventTeam) {
      // Negative events (red card, own goal) → market price should FALL → buy NO
      return isNegativeEvent ? 'NO' : 'YES';
    }

    // Question might be about the opponent — flip the logic
    return isNegativeEvent ? 'YES' : 'NO';
  }

  private getOutcomePrice(market: PolymarketMarket, side: 'YES' | 'NO'): number {
    const idx = side === 'YES' ? 0 : 1;
    const raw = market.outcomePrices[idx];
    return raw !== undefined ? parseFloat(raw) : 0.5;
  }

  private isSoccerMarket(m: GammaMarket): boolean {
    const tags = (m.tags ?? []).map((t: string) => t.toLowerCase());
    const text = `${m.question ?? ''} ${m.description ?? ''}`.toLowerCase();
    return (
      tags.some((t) =>
        t.includes('soccer') || t.includes('football') ||
        t.includes('premier league') || t.includes('la liga') ||
        t.includes('serie a') || t.includes('bundesliga') ||
        t.includes('champions league') || t.includes('sports'),
      ) ||
      text.includes('soccer') ||
      text.includes(' fc ') ||
      text.includes('premier league') ||
      text.includes('champions league')
    );
  }

  private mapMarket(m: GammaMarket): PolymarketMarket {
    let outcomePrices: string[] = [];
    try {
      outcomePrices = Array.isArray(m.outcomePrices)
        ? m.outcomePrices
        : JSON.parse(m.outcomePrices ?? '[]');
    } catch {
      outcomePrices = [];
    }

    let outcomes: string[] = [];
    try {
      outcomes = Array.isArray(m.outcomes)
        ? m.outcomes
        : JSON.parse(m.outcomes ?? '["Yes","No"]');
    } catch {
      outcomes = ['Yes', 'No'];
    }

    return {
      id: m.id ?? '',
      conditionId: m.conditionId ?? m.id ?? '',
      question: m.question ?? '',
      slug: m.slug ?? '',
      outcomes,
      outcomePrices,
      volume: Number(m.volume ?? 0),
      liquidity: Number(m.liquidity ?? 0),
      endDate: m.endDate ?? '',
      tags: m.tags ?? [],
      description: m.description ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Raw Gamma API shape (partial — only fields we use)
// ---------------------------------------------------------------------------

interface GammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  volume?: number | string;
  liquidity?: number | string;
  endDate?: string;
  tags?: string[];
  description?: string;
  active?: boolean;
  closed?: boolean;
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
