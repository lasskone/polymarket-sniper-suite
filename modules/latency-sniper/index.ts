/**
 * Latency Sniper — main orchestration loop.
 *
 * Pipeline per tick:
 *   1. pollLiveMatches()           → new football events
 *   2. findMatchingMarket(event)   → best Polymarket market
 *   3. estimatePriceImpact(…)      → expected price + edge
 *   4. Filter: edge < minProfitThreshold → skip
 *   5. riskManager.checkOrder()    → gate size / daily limits
 *   6. tradeExecutor.executeTrade() → FOK order or paper log
 *   7. recordTrade() + updateTradeStatus() → persist to Supabase
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig }                             from '../shared/config.js';
import { getSupabaseClient }                      from '../shared/supabase-client.js';
import { createRiskManager }                      from '../shared/risk-manager.js';
import { recordTrade, updateTradeStatus,
         recordOpportunity, markOpportunityTraded } from '../shared/supabase-client.js';
import { loadLatencySniperConfig }                from './config.js';
import { EventDetector, type NewEvent }           from './event-detector.js';
import { MarketMatcher, type MatchResult }        from './market-matcher.js';
import { estimatePriceImpact }                    from './utils/pricing.js';
import { createTradeExecutor }                    from './trade-executor.js';
import { createLogger }                           from '../shared/logger.js';
import type { Opportunity }                       from './types.js';

const log = createLogger('latency-sniper');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runLatencySniper(): Promise<void> {
  const mainConfig = loadConfig();
  const cfg        = loadLatencySniperConfig(mainConfig);

  if (!cfg.enabled) {
    log.info('Module disabled — set ENABLE_LATENCY_SNIPER=true to activate.');
    return;
  }

  log.info('Starting latency sniper', {
    tradingMode:           cfg.tradingMode,
    pollIntervalMs:        cfg.pollIntervalMs,
    targetLeagues:         cfg.targetLeagues,
    targetEventTypes:      cfg.targetEventTypes,
    maxApiCallsPerMinute:  cfg.maxApiCallsPerMinute,
    minProfitThreshold:    cfg.minProfitThreshold,
    maxPositionSizeUsdc:   cfg.maxPositionSizeUsdc,
  });

  // ── Initialize services ──────────────────────────────────────────────────
  const supabase = getSupabaseClient();

  const riskManager = createRiskManager(
    {
      maxPositionSizeUsdc:          cfg.maxPositionSizeUsdc,
      maxPositionPercentage:        mainConfig.maxPositionPercentage,
      minPositionSizeUsdc:          mainConfig.minPositionSizeUsdc,
      dailyLossLimitUsdc:           mainConfig.dailyLossLimitUsdc,
      maxExposurePerMarketUsdc:     mainConfig.maxExposurePerMarketUsdc,
      maxGlobalExposureUsdc:        mainConfig.maxGlobalExposureUsdc,
      cooldownMinutes:              mainConfig.cooldownMinutes,
    },
    supabase,
  );

  const detector = new EventDetector(cfg);
  const matcher  = new MarketMatcher();

  const executor = createTradeExecutor({
    ...cfg,
    privateKey:    mainConfig.privateKey,
    walletAddress: mainConfig.walletAddress,
  });

  // Pre-initialize executor so first-trade latency is lower
  if (cfg.tradingMode === 'live') {
    await executor.initialize();
  }

  let tickCount = 0;

  while (true) {
    tickCount++;
    const tickStart = Date.now();

    try {
      const newEvents = await detector.pollLiveMatches();

      if (newEvents.length === 0) {
        log.debug('Tick complete — no new events', { tick: tickCount });
      }

      for (const ne of newEvents) {
        await handleNewEvent(ne, matcher, executor, riskManager, cfg);
      }
    } catch (err) {
      log.error('Unhandled error in poll loop', { error: String(err), tick: tickCount });
    }

    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, cfg.pollIntervalMs - elapsed));
  }
}

// ---------------------------------------------------------------------------
// Per-event handler
// ---------------------------------------------------------------------------

async function handleNewEvent(
  ne: NewEvent,
  matcher: MarketMatcher,
  executor: import('./trade-executor.js').TradeExecutor,
  riskManager: ReturnType<typeof createRiskManager>,
  cfg: ReturnType<typeof loadLatencySniperConfig>,
): Promise<void> {
  const { match, event } = ne;

  log.info('Event detected', {
    fixtureId:   match.fixtureId,
    league:      match.league,
    match:       `${match.homeTeam.name} ${match.score.home}–${match.score.away} ${match.awayTeam.name}`,
    eventType:   event.type,
    eventDetail: event.detail,
    team:        event.team.name,
    player:      event.player.name,
    minute:      event.time,
  });

  // ── Step 1: Find market ────────────────────────────────────────────────────
  const matchResult: MatchResult | null = await matcher.findMatchingMarket(ne);

  if (!matchResult) {
    log.debug('No matching market — skipping', {
      fixtureId: match.fixtureId,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
    });
    return;
  }

  // ── Step 2: Price estimate ─────────────────────────────────────────────────
  const estimate = estimatePriceImpact(
    ne,
    matchResult.market,
    matchResult.side,
    matchResult.currentPrice,
  );

  // ── Step 3: Edge filter ────────────────────────────────────────────────────
  if (estimate.edge < cfg.minProfitThreshold) {
    log.debug('Edge below threshold', {
      edge: estimate.edge,
      threshold: cfg.minProfitThreshold,
      market: matchResult.market.question,
    });

    // Record as 'missed' opportunity for analysis
    await recordOpportunity({
      module:          'latency-sniper',
      marketId:        matchResult.market.id,
      marketSlug:      matchResult.market.slug,
      opportunityType: event.type.toLowerCase(),
      currentPrice:    estimate.currentPrice,
      expectedPrice:   estimate.expectedPrice,
      edge:            estimate.edge,
      confidence:      estimate.confidence,
      status:          'missed',
      metadata: {
        fixtureId:   match.fixtureId,
        league:      match.league,
        eventDetail: event.detail,
        reason:      'edge_below_threshold',
      },
    });
    return;
  }

  // ── Step 4: Log opportunity ────────────────────────────────────────────────
  log.info('OPPORTUNITY IDENTIFIED', {
    fixtureId:    match.fixtureId,
    league:       match.league,
    match:        `${match.homeTeam.name} vs ${match.awayTeam.name}`,
    eventType:    event.type,
    eventDetail:  event.detail,
    team:         event.team.name,
    minute:       event.time,
    score:        match.score,
    question:     matchResult.market.question,
    relevance:    matchResult.relevanceScore,
    side:         matchResult.side,
    liquidity:    matchResult.market.liquidity,
    currentPrice: estimate.currentPrice,
    expectedPrice: estimate.expectedPrice,
    edge:         estimate.edge,
    confidence:   estimate.confidence,
    reasoning:    estimate.reasoning,
    tradingMode:  cfg.tradingMode,
  });

  // Record opportunity as detected
  const oppId = await recordOpportunity({
    module:          'latency-sniper',
    marketId:        matchResult.market.id,
    marketSlug:      matchResult.market.slug,
    opportunityType: event.type.toLowerCase(),
    currentPrice:    estimate.currentPrice,
    expectedPrice:   estimate.expectedPrice,
    edge:            estimate.edge,
    confidence:      estimate.confidence,
    status:          'detected',
    metadata: {
      fixtureId:   match.fixtureId,
      league:      match.league,
      eventDetail: event.detail,
      team:        event.team.name,
      minute:      event.time,
      score:       match.score,
    },
    // Opportunity expires when the match ends (rough estimate)
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  });

  // ── Step 5: Risk check ─────────────────────────────────────────────────────
  const riskCheck = await riskManager.checkOrder(
    'latency-sniper',
    matchResult.market.id,
    'BUY',
    cfg.maxPositionSizeUsdc,
    estimate.currentPrice,
  );

  if (!riskCheck.allowed) {
    log.warn('Risk check blocked trade', {
      reason:    riskCheck.reason,
      marketId:  matchResult.market.id,
    });
    return;
  }

  const sizeUsdc = riskCheck.adjustedSize;

  // ── Step 6: Build opportunity object ──────────────────────────────────────
  const opportunity: Opportunity = {
    event:         ne,
    market:        matchResult.market,
    priceEstimate: estimate,
    side:          matchResult.side,
    sizeUsdc,
  };

  // ── Step 7: Execute trade ──────────────────────────────────────────────────
  const result = await executor.executeTrade(opportunity);

  if (!result.success) {
    log.warn('Trade execution failed', {
      error:    result.error,
      marketId: matchResult.market.id,
      side:     matchResult.side,
      sizeUsdc,
    });
    return;
  }

  log.info(result.paper ? 'PAPER trade recorded' : 'LIVE trade executed', {
    orderId:    result.orderId,
    filledSize: result.filledSize,
    avgPrice:   result.avgPrice,
    amountUsdc: result.amountUsdc,
    paper:      result.paper,
  });

  // ── Step 8: Persist to Supabase ───────────────────────────────────────────
  const tokenAmount = result.filledSize ?? (sizeUsdc / estimate.currentPrice);
  const amountUsdc  = result.amountUsdc ?? sizeUsdc;
  const expectedProfit = estimate.edge * amountUsdc;

  await recordTrade({
    module:          'latency-sniper',
    marketId:        matchResult.market.id,
    marketSlug:      matchResult.market.slug,
    side:            'BUY',
    price:           result.avgPrice ?? estimate.currentPrice,
    size:            tokenAmount,
    amountUsdc,
    orderId:         result.orderId ?? `PAPER-${Date.now()}`,
    status:          result.paper ? 'filled' : 'pending',
    expectedProfit,
    metadata: {
      fixtureId:    match.fixtureId,
      league:       match.league,
      eventType:    event.type,
      eventDetail:  event.detail,
      team:         event.team.name,
      minute:       event.time,
      confidence:   estimate.confidence,
      reasoning:    estimate.reasoning,
      paper:        result.paper,
    },
  });

  // Update opportunity status to 'traded'
  if (oppId) {
    await markOpportunityTraded(oppId);
  }

  // For live trades, update status once fill is confirmed
  if (!result.paper && result.orderId) {
    await updateTradeStatus(result.orderId, 'filled');
  }

  // Notify risk manager of the trade (P&L unknown until market resolves — use 0 as placeholder)
  // Real P&L will be updated when the market resolves via a separate settlement process
  await riskManager.recordPnl('latency-sniper', matchResult.market.id, 0);
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
