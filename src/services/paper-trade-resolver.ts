/**
 * Paper Trade Resolver — sportsbook-arb settlement tracking
 *
 * Polls Supabase every 10 minutes for open sportsbook-arb paper trades,
 * queries the Polymarket CLOB API to check whether each market has settled,
 * and writes the final status (won/lost) and net_profit_usd back to the row.
 *
 * ── API findings (verified 2026-07-14) ──────────────────────────────────────
 *
 * Gamma API /markets:
 *   - The `clob_token_id` query parameter is BROKEN — it does not filter
 *     results; any value (real or bogus) returns the same default paginated
 *     list. Confirmed by testing: bogus token `123456` and a real token both
 *     returned the same unrelated market.
 *   - The `condition_id` query parameter is similarly non-functional.
 *   - `tokens[].winner` does NOT exist on the /markets endpoint at all.
 *   - `outcomePrices` IS reliable (the winning outcome settles at "1"),
 *     but can only be accessed by numeric market ID or by paginating all markets.
 *
 * CLOB API /markets/{conditionId}:
 *   - Returns a `tokens` array with `{ token_id, outcome, price, winner: bool }`.
 *   - `winner: true` is set on the winning outcome after on-chain settlement.
 *   - This is the authoritative settlement source.
 *   - Confirmed on real settled sports markets (e.g. NCAAB Arizona State,
 *     NBA Miami/Cleveland) where `winner: [true, false]` was observed.
 *   - Requires the conditionId (0x...) — CANNOT be looked up by token_id alone.
 *
 * ── Resolution flow ──────────────────────────────────────────────────────────
 *
 * Each open paper trade row must have `condition_id` populated.
 * OddsPapi does NOT provide conditionId in its Polymarket outcome data;
 * bot/index.ts therefore does a CLOB market scan at signal time to find the
 * conditionId from the token_id and stores it in the paper_trade row.
 *
 * Rows where `condition_id IS NULL` (conditionId lookup failed at signal time)
 * are skipped — they will never resolve. This is a known limitation.
 *
 * For each row with condition_id:
 *   GET https://clob.polymarket.com/markets/{conditionId}
 *   → tokens[].winner: bool
 *   → If closed && any token with our token_id has winner=true → WON
 *   → If closed && our token has winner=false and another token has winner=true → LOST
 *   → net_profit_usd = (payout − entry_price) × shares
 *
 * ── Note on bookmakerOutcomeId ────────────────────────────────────────────────
 *
 * OddsPapi's `exchangeMeta.bookmakerOutcomeId` is the purported Polymarket
 * ERC-1155 token ID. This value has NOT been verified against a real live API
 * response (OddsPapi rate limit was exhausted during verification on 2026-07-14).
 * If it turns out to NOT be a real token_id, the token_id column in paper_trades
 * will be meaningless and conditionId lookup must use a different strategy.
 *
 * Error handling:
 *   - Supabase errors propagate → triggers runWithRestart in bot/index.ts
 *   - Per-row CLOB fetch/parse errors are caught and logged; row retried next cycle
 *
 * Export: runPaperTradeResolver(): Promise<void>
 *   Never resolves; designed to run inside runWithRestart.
 */

import { getSupabaseClient } from '../../modules/shared/supabase-client.js';
import { createLogger }      from '../../modules/shared/logger.js';

const log = createLogger('paper-trade-resolver');

const POLL_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const CLOB_BASE        = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// CLOB API raw shape for /markets/{conditionId}
// Confirmed by real API response on 2026-07-14.
// ---------------------------------------------------------------------------

interface ClobToken {
  token_id: string;
  outcome:  string;
  price:    number;
  winner:   boolean;
}

interface ClobMarket {
  closed:  boolean;
  tokens:  ClobToken[];
}

// ---------------------------------------------------------------------------
// Resolve a single open row via CLOB API
// ---------------------------------------------------------------------------

async function resolveRow(row: {
  id:           unknown;
  token_id:     string | null;
  condition_id: string | null;
  entry_price:  string | number | null;
  shares:       string | number | null;
}): Promise<void> {
  if (!row.condition_id) {
    // conditionId was not found at signal time — cannot resolve.
    // (OddsPapi does not provide conditionId; bot/index.ts attempts a CLOB
    // scan to populate it but may fail for uncommon markets.)
    return;
  }

  let market: ClobMarket;
  try {
    const res = await fetch(
      `${CLOB_BASE}/markets/${encodeURIComponent(row.condition_id)}`,
    );
    if (!res.ok) {
      log.warn('CLOB API fetch failed for conditionId', {
        conditionId: row.condition_id,
        status:      res.status,
      });
      return;
    }
    market = (await res.json()) as ClobMarket;
  } catch (err) {
    log.warn('CLOB API fetch error', { conditionId: row.condition_id, error: String(err) });
    return;
  }

  // Market not yet closed on-chain — check again next cycle.
  if (!market.closed) return;

  if (!Array.isArray(market.tokens) || market.tokens.length === 0) {
    log.warn('CLOB: closed market but no tokens in response', {
      conditionId: row.condition_id,
    });
    return;
  }

  // Find the token that won (winner: true).
  // If any token has winner=true but none of them matches our token_id, we lost.
  // If no token has winner=true yet, the market closed but hasn't settled on-chain.
  const anyWinner = market.tokens.some((t) => t.winner);
  if (!anyWinner) {
    // Closed but no winner set yet — may be in dispute or pending UMA resolution.
    log.info('CLOB: closed market, winner not yet set — will retry', {
      conditionId: row.condition_id,
    });
    return;
  }

  // If we have a token_id, use it for precise matching.
  // If token_id is null (bookmakerOutcomeId was absent), we can't determine
  // which leg we're tracking — skip.
  if (!row.token_id) {
    log.warn('Paper trade has conditionId but no token_id — cannot determine outcome', {
      id: row.id,
    });
    return;
  }

  const ourToken = market.tokens.find((t) => t.token_id === row.token_id);
  if (!ourToken) {
    log.warn('CLOB: our token_id not found in market tokens', {
      conditionId: row.condition_id,
      tokenId:     row.token_id,
    });
    return;
  }

  const won        = ourToken.winner;
  const payout     = won ? 1 : 0;
  const entryPrice = Number(row.entry_price ?? 0);
  const shares     = Number(row.shares ?? 0);
  const netProfit  = (payout - entryPrice) * shares;

  const db = getSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('paper_trades')
    .update({
      status:         won ? 'won' : 'lost',
      net_profit_usd: netProfit,
      resolved_at:    new Date().toISOString(),
    })
    .eq('id', row.id);

  if (error) {
    // Propagate — Supabase write failure is unrecoverable without restart.
    throw new Error(`paper_trades update failed for id=${row.id}: ${error.message}`);
  }

  log.info('Paper trade resolved', {
    id:         row.id,
    conditionId: row.condition_id,
    tokenId:    row.token_id,
    status:     won ? 'won' : 'lost',
    netProfit:  netProfit.toFixed(4),
  });
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

export async function runPaperTradeResolver(): Promise<void> {
  log.info('Paper trade resolver started', { pollIntervalMs: POLL_INTERVAL_MS });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const db = getSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('paper_trades')
        .select('id, token_id, condition_id, entry_price, shares')
        .eq('module', 'sportsbook-arb')
        .eq('status', 'open');

      if (error) {
        // Supabase query failure → propagate so runWithRestart resets.
        throw new Error(`paper_trades query failed: ${error.message}`);
      }

      const rows = (data ?? []) as Array<{
        id:           unknown;
        token_id:     string | null;
        condition_id: string | null;
        entry_price:  string | number | null;
        shares:       string | number | null;
      }>;

      log.info('Checking open sportsbook-arb paper trades', { count: rows.length });

      for (const row of rows) {
        // Per-row errors (CLOB fetch failures) are caught inside resolveRow.
        // Supabase write failures propagate and are re-thrown above.
        await resolveRow(row);
      }
    } catch (err) {
      // Re-throw so runWithRestart in bot/index.ts triggers a restart.
      throw err;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
