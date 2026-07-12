/**
 * Pricing utilities for the latency sniper module.
 * Estimates fair value after a detected match event.
 */

export interface PricingContext {
  eventType: 'GOAL' | 'RED_CARD' | 'HALF_TIME' | 'FULL_TIME';
  scoringTeam: 'HOME' | 'AWAY';
  currentScore: { home: number; away: number };
  minuteElapsed: number;
  priorImpliedProbability: number;
}

/**
 * Naive Bayesian bump — real implementation should use a Dixon-Coles
 * or Poisson model calibrated on historical data.
 */
export function estimateFairValueAfterGoal(ctx: PricingContext): {
  home: number;
  away: number;
  draw: number;
} {
  const { currentScore, minuteElapsed } = ctx;
  const remainingFraction = Math.max(0, (90 - minuteElapsed) / 90);

  let homeProbBump = 0;
  let awayProbBump = 0;

  if (ctx.scoringTeam === 'HOME') {
    homeProbBump = 0.15 * remainingFraction;
    awayProbBump = -0.1 * remainingFraction;
  } else {
    awayProbBump = 0.15 * remainingFraction;
    homeProbBump = -0.1 * remainingFraction;
  }

  const scoreDiff = currentScore.home - currentScore.away;
  const baseHomePr = 0.45 + scoreDiff * 0.08;
  const baseAwayPr = 0.35 - scoreDiff * 0.08;

  const home = Math.min(0.98, Math.max(0.02, baseHomePr + homeProbBump));
  const away = Math.min(0.98, Math.max(0.02, baseAwayPr + awayProbBump));
  const draw = Math.min(0.96, Math.max(0.02, 1 - home - away));

  return { home, away, draw };
}

export function computeEdge(fairValue: number, marketPrice: number): number {
  return (fairValue - marketPrice) / marketPrice;
}
