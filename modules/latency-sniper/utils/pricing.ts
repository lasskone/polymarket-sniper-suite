/**
 * Pricing model for the latency-sniper module.
 *
 * Estimates the expected price movement on a Polymarket YES/NO market
 * after a live football event (goal, red card, penalty awarded).
 *
 * Model:
 *   - Time-weighted impact: events early in the match have bigger effect
 *   - Score-state adjustment: first goal in a 0–0 match has bigger effect
 *     than a third goal when already winning 2–0
 *   - Liquidity dampener: thin markets move more
 *   - All outputs clamped to [0.02, 0.98] (never fully certain)
 *
 * This is an approximation. For production use, calibrate coefficients
 * against historical Polymarket price data.
 */

import type { NewEvent } from '../event-detector.js';
import type { PolymarketMarket } from '../market-matcher.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PriceEstimate {
  currentPrice: number;    // price of the relevant outcome NOW (0–1)
  expectedPrice: number;   // model's estimate of fair value AFTER event (0–1)
  edge: number;            // expectedPrice − currentPrice
  confidence: number;      // 0–100
  reasoning: string;       // human-readable explanation
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Master estimator — dispatches to the right sub-model based on event type.
 *
 * @param ne          The new football event
 * @param market      The Polymarket market to price
 * @param side        Which outcome we're pricing ('YES' | 'NO')
 * @param currentPrice  Current market price for that outcome
 */
export function estimatePriceImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): PriceEstimate {
  const detail = ne.event.detail.toLowerCase();
  const type   = ne.event.type.toLowerCase();

  let expectedPrice: number;
  let reasoning: string;
  let rawConfidence: number;

  if (type === 'goal') {
    if (detail.includes('own goal')) {
      // Own goal benefits the opposite team
      ({ price: expectedPrice, reasoning, confidence: rawConfidence } =
        applyGoalImpact(ne, market, side, currentPrice, true));
    } else {
      ({ price: expectedPrice, reasoning, confidence: rawConfidence } =
        applyGoalImpact(ne, market, side, currentPrice, false));
    }
  } else if (type === 'card' && detail.includes('red card')) {
    ({ price: expectedPrice, reasoning, confidence: rawConfidence } =
      applyRedCardImpact(ne, market, side, currentPrice));
  } else if (type === 'var' && detail.includes('penalty')) {
    ({ price: expectedPrice, reasoning, confidence: rawConfidence } =
      applyPenaltyAwardedImpact(ne, market, side, currentPrice));
  } else {
    // Unknown / unhandled event type — no edge
    return {
      currentPrice,
      expectedPrice: currentPrice,
      edge: 0,
      confidence: 0,
      reasoning: `No pricing model for event type "${ne.event.type}: ${ne.event.detail}"`,
    };
  }

  // Apply liquidity dampener: thin markets move more
  const liquidityFactor = liquidityDampener(market.liquidity);
  const adjustedExpected = currentPrice + (expectedPrice - currentPrice) * liquidityFactor;
  const clamped = clamp(adjustedExpected, 0.02, 0.98);

  // Late-match confidence reduction (after 75')
  const timeConfidence = minuteConfidence(ne.match.minute);
  const confidence = clamp(Math.round(rawConfidence * timeConfidence), 0, 100);

  return {
    currentPrice,
    expectedPrice: round4(clamped),
    edge: round4(clamped - currentPrice),
    confidence,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Goal impact
// ---------------------------------------------------------------------------

export function calculateGoalImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): number {
  return applyGoalImpact(ne, market, side, currentPrice, false).price;
}

function applyGoalImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
  isOwnGoal: boolean,
): { price: number; reasoning: string; confidence: number } {
  const { match, event } = ne;
  const minute = match.minute;
  const scoreDiff = match.score.home - match.score.away;

  // Determine if the event team is home or away
  const isEventTeamHome = event.team.id === match.homeTeam.id;

  // After an own goal, the OPPONENT benefits — flip perspective
  const benefitHome = isOwnGoal ? !isEventTeamHome : isEventTeamHome;

  // Time remaining factor: 0 (90') → 1 (0')
  const remaining = Math.max(0, (90 - minute) / 90);

  // First goal has bigger impact than subsequent goals
  const totalGoals = match.score.home + match.score.away;
  const isFirstGoal = totalGoals <= 1;  // ≤1 because the goal was just scored
  const firstGoalMultiplier = isFirstGoal ? 1.3 : 1.0;

  // Base impact: 20% of current price, scaled by time remaining
  const baseImpact = 0.20 * remaining * firstGoalMultiplier;

  // Determine direction for this market side
  //   - If market asks "will [team] win?" and [team] scored → YES price ↑
  //   - If [team] conceded (isOwnGoal) → YES price ↓
  const isPositiveForSide =
    (side === 'YES' && benefitHome) ||
    (side === 'NO'  && !benefitHome);

  const direction = isPositiveForSide ? 1 : -1;
  const newPrice = currentPrice + direction * baseImpact * currentPrice;

  const scoringTeam = isOwnGoal
    ? (isEventTeamHome ? match.awayTeam.name : match.homeTeam.name)
    : event.team.name;

  const reasoning = [
    `${isOwnGoal ? 'Own goal (benefits ' + scoringTeam + ')' : 'Goal by ' + event.team.name}`,
    `at minute ${minute}`,
    `(${match.homeTeam.name} ${match.score.home}–${match.score.away} ${match.awayTeam.name}).`,
    `Base impact: ${(baseImpact * 100).toFixed(1)}%`,
    isFirstGoal ? '(first goal × 1.3 multiplier).' : '.',
    `Side: ${side} → ${direction > 0 ? 'price increase' : 'price decrease'}.`,
  ].join(' ');

  // Confidence: high if early and clear, lower if late or own goal
  let confidence = 85;
  if (minute > 75)      confidence -= 20;
  else if (minute > 60) confidence -= 10;
  if (isOwnGoal)        confidence -= 10;
  if (Math.abs(scoreDiff) >= 2) confidence -= 15;  // blowout — already priced

  return { price: newPrice, reasoning, confidence };
}

// ---------------------------------------------------------------------------
// Red card impact
// ---------------------------------------------------------------------------

export function calculateRedCardImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): number {
  return applyRedCardImpact(ne, market, side, currentPrice).price;
}

function applyRedCardImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): { price: number; reasoning: string; confidence: number } {
  const { match, event } = ne;
  const minute = match.minute;

  const remaining = Math.max(0, (90 - minute) / 90);
  const isEventTeamHome = event.team.id === match.homeTeam.id;

  // Red card hurts the card team
  const hurtHome = isEventTeamHome;

  // Impact: 25% base, scaled by time remaining
  // More impactful if tied or close score
  const scoreDiff = Math.abs(match.score.home - match.score.away);
  const closeScore = scoreDiff <= 1;
  const baseImpact = 0.25 * remaining * (closeScore ? 1.2 : 0.9);

  // Direction for this side
  const isNegativeForSide =
    (side === 'YES' && hurtHome) ||
    (side === 'NO'  && !hurtHome);

  const direction = isNegativeForSide ? -1 : 1;
  const newPrice = currentPrice + direction * baseImpact * currentPrice;

  const reasoning = [
    `Red card for ${event.team.name} at minute ${minute}.`,
    `Impact: ${(baseImpact * 100).toFixed(1)}%`,
    closeScore ? '(close match × 1.2).' : '(not close × 0.9).',
    `Side: ${side} → ${direction < 0 ? 'price decrease' : 'price increase'}.`,
  ].join(' ');

  let confidence = 80;
  if (minute > 80)       confidence -= 15;
  else if (minute > 65)  confidence -= 5;
  if (!closeScore)       confidence -= 10;

  return { price: newPrice, reasoning, confidence };
}

// ---------------------------------------------------------------------------
// Penalty awarded impact
// ---------------------------------------------------------------------------

export function calculatePenaltyImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): number {
  return applyPenaltyAwardedImpact(ne, market, side, currentPrice).price;
}

function applyPenaltyAwardedImpact(
  ne: NewEvent,
  market: PolymarketMarket,
  side: 'YES' | 'NO',
  currentPrice: number,
): { price: number; reasoning: string; confidence: number } {
  const { match, event } = ne;
  const minute = match.minute;

  const remaining = Math.max(0, (90 - minute) / 90);
  const isEventTeamHome = event.team.id === match.homeTeam.id;

  // Penalty converts ~75% of the time → partial goal impact
  // Impact: 12% base (lower than goal since it's not scored yet)
  const baseImpact = 0.12 * remaining;

  const isPositiveForSide =
    (side === 'YES' && isEventTeamHome) ||
    (side === 'NO'  && !isEventTeamHome);

  const direction = isPositiveForSide ? 1 : -1;
  const newPrice = currentPrice + direction * baseImpact * currentPrice;

  const reasoning = [
    `Penalty awarded to ${event.team.name} at minute ${minute}.`,
    `~75% conversion rate; base impact: ${(baseImpact * 100).toFixed(1)}%.`,
    `Side: ${side} → ${direction > 0 ? 'price increase' : 'price decrease'}.`,
  ].join(' ');

  // Lower confidence — penalty not yet scored
  let confidence = 60;
  if (minute > 80) confidence -= 10;

  return { price: newPrice, reasoning, confidence };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Markets with thin liquidity experience larger price swings.
 * Returns a multiplier > 1 for thin markets and ≈ 1 for deep markets.
 */
function liquidityDampener(liquidity: number): number {
  if (liquidity >= 50_000) return 0.85;   // deep — market won't move as much
  if (liquidity >= 10_000) return 1.0;    // normal
  if (liquidity >= 1_000)  return 1.15;   // thin
  return 1.3;                             // very thin
}

/**
 * Late in the match, our confidence falls because the impact of an event
 * is harder to estimate (less time for the situation to develop).
 */
function minuteConfidence(minute: number): number {
  if (minute <= 60) return 1.0;
  if (minute <= 75) return 0.9;
  if (minute <= 85) return 0.75;
  return 0.6;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
