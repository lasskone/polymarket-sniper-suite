/**
 * Dip-Arb Dynamic Position Sizing — Pure Functions
 *
 * These pure functions compute the per-trade share count for DipArbService
 * based on the current USDC balance and configured position-size percentage.
 *
 * No I/O, no side effects — fully unit-testable.
 *
 * Usage flow in bot/index.ts:
 *   1. Fetch balance: sdk.tradingService.getBalanceAllowance('COLLATERAL')
 *   2. computeTargetNotional(balance, positionSizePct) → uncapped notional
 *   3. capNotional(uncappedNotional, maxPositionSizeUsdc) → capped notional
 *   4. notionalToShares(cappedNotional, sumTarget) → integer share count
 *   5. sdk.dipArb.updateConfig({ shares })
 *
 * Repeat steps 1–5 on every 'rotate' event to adapt to balance changes.
 */

/** Minimum shares DipArbService will accept (avoids sub-$1.50 trades). */
export const MIN_SHARES = 1;

/**
 * Compute uncapped target notional from a USDC balance and a percentage.
 *
 * @param balanceUsdc    - Current USDC collateral balance (from CLOB API)
 * @param positionSizePct - Percentage of balance to deploy (e.g. 2 = 2%)
 * @returns Notional in USDC (may still exceed the hard cap)
 *
 * @example
 * computeTargetNotional(1000, 2)  // → 20
 * computeTargetNotional(500, 5)   // → 25
 * computeTargetNotional(0, 2)     // → 0
 */
export function computeTargetNotional(balanceUsdc: number, positionSizePct: number): number {
  if (balanceUsdc <= 0 || positionSizePct <= 0) return 0;
  return balanceUsdc * (positionSizePct / 100);
}

/**
 * Apply the hard notional cap (from riskManager / config.maxPositionSizeUsdc).
 *
 * @param targetNotional     - Uncapped notional from computeTargetNotional()
 * @param maxPositionSizeUsdc - Hard cap in USDC (e.g. 100)
 * @returns The lesser of the two values
 *
 * @example
 * capNotional(20, 100)  // → 20  (no cap applied)
 * capNotional(20, 15)   // → 15  (cap applied)
 * capNotional(0, 100)   // → 0
 */
export function capNotional(targetNotional: number, maxPositionSizeUsdc: number): number {
  return Math.min(targetNotional, maxPositionSizeUsdc);
}

/**
 * Convert a notional USDC amount to an integer share count for DipArbService.
 *
 * DipArb cost model: each "round" buys one leg at ~legPrice and hedges at ~(sumTarget − legPrice).
 * Total cost per share-pair ≈ sumTarget dollars. Therefore:
 *   shares = floor(notional / sumTarget)
 *
 * @param notionalUsdc - Capped notional from capNotional()
 * @param sumTarget    - Configured sumTarget (e.g. 0.97; cost per share-pair)
 * @returns Integer share count, minimum MIN_SHARES
 *
 * @example
 * notionalToShares(20, 0.97)   // floor(20.6) = 20
 * notionalToShares(9.7, 0.97)  // floor(10) = 10
 * notionalToShares(0.5, 0.97)  // floor(0.5) = 0 → clamped to MIN_SHARES (1)
 */
export function notionalToShares(notionalUsdc: number, sumTarget: number): number {
  if (notionalUsdc <= 0 || sumTarget <= 0) return MIN_SHARES;
  return Math.max(MIN_SHARES, Math.floor(notionalUsdc / sumTarget));
}

/**
 * All-in-one helper: balance → share count.
 *
 * Equivalent to chaining computeTargetNotional → capNotional → notionalToShares.
 *
 * @param balanceUsdc         - Current USDC balance
 * @param positionSizePct     - % of balance to deploy
 * @param maxPositionSizeUsdc - Hard notional cap
 * @param sumTarget           - DipArb sumTarget (cost per share-pair)
 * @returns Integer share count
 */
export function computeShares(
  balanceUsdc: number,
  positionSizePct: number,
  maxPositionSizeUsdc: number,
  sumTarget: number,
): number {
  const uncapped = computeTargetNotional(balanceUsdc, positionSizePct);
  const capped   = capNotional(uncapped, maxPositionSizeUsdc);
  return notionalToShares(capped, sumTarget);
}
