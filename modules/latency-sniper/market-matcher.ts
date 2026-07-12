/**
 * MarketMatcher — maps a live MatchEvent to candidate Polymarket
 * markets and returns the best order target.
 */

import type { MatchEvent } from './event-detector.js';

export interface MarketTarget {
  conditionId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  expectedFairValue: number;
  currentPrice: number;
  edgePct: number;
}

export class MarketMatcher {
  private clobApiBase: string;
  private apiKey: string;

  constructor(clobApiBase: string, apiKey: string) {
    this.clobApiBase = clobApiBase;
    this.apiKey = apiKey;
  }

  /**
   * Search for open Polymarket markets related to a fixture.
   * Returns candidate markets sorted by edge (highest first).
   */
  async findTargets(event: MatchEvent): Promise<MarketTarget[]> {
    // Stub — full implementation queries the CLOB gamma markets endpoint
    // and filters by keyword match on team names + event type.
    console.log(`[MarketMatcher] Searching markets for event:`, event);
    return [];
  }
}
