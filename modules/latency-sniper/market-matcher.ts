/**
 * MarketMatcher — maps a live match NewEvent to candidate Polymarket
 * markets and returns the best order targets.
 *
 * Stub: full implementation queries the CLOB gamma markets endpoint
 * and filters by keyword match on team names + event type.
 */

import type { NewEvent } from './event-detector.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('market-matcher');

export interface MarketTarget {
  conditionId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  expectedFairValue: number;
  currentPrice: number;
  edgePct: number;
}

export class MarketMatcher {
  constructor(
    private readonly clobApiBase: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Search for open Polymarket markets related to a fixture event.
   * Returns candidate markets sorted by edge (highest first).
   */
  async findTargets(ne: NewEvent): Promise<MarketTarget[]> {
    log.debug('Searching markets for event', {
      fixtureId: ne.match.fixtureId,
      eventType: ne.event.type,
      eventDetail: ne.event.detail,
      team: ne.event.team.name,
    });
    // TODO: query CLOB gamma endpoint, match by team names + event type
    return [];
  }
}
