#!/usr/bin/env npx tsx
/**
 * Mark Suspect Duplicate Trades
 *
 * One-off script — run manually via:
 *   railway run tsx scripts/mark-suspect-trades.ts
 * OR locally (with .env):
 *   tsx scripts/mark-suspect-trades.ts
 *
 * What it does:
 *   1. Fetches all logic-arb paper_trades from July 22–23 2026 (the burst window).
 *   2. For each (market_label, net_profit_usd) pair, keeps the EARLIEST row as the
 *      "real" trade and marks every subsequent row as suspect_duplicate = true.
 *   3. Prints a diagnostic comparing raw vs de-duplicated counts and P&L.
 *
 * Prerequisites:
 *   SUPABASE_URL              — Supabase project URL.
 *   SUPABASE_SERVICE_ROLE_KEY — (or SUPABASE_ANON_KEY as fallback).
 *   The 20260728000000_paper_trades_dedup.sql migration must have been applied.
 *
 * Safe to re-run: subsequent runs see the rows already flagged and skip them.
 */

import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

// ── Config ────────────────────────────────────────────────────────────────────

/** Inclusive window that contains the burst. */
const WINDOW_START = '2026-07-22T00:00:00Z';
const WINDOW_END   = '2026-07-24T00:00:00Z';  // exclusive upper bound

const DRY_RUN = process.argv.includes('--dry-run');

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaperTradeRow {
  id:              string;
  module:          string;
  market_label:    string;
  net_profit_usd:  string | number | null;
  opened_at:       string;
  suspect_duplicate: boolean;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = getSupabaseClient();

  console.log(`\nmark-suspect-trades — window: ${WINDOW_START} → ${WINDOW_END}`);
  if (DRY_RUN) console.log('DRY RUN — no rows will be updated\n');

  // Fetch all logic-arb rows in the burst window (no Supabase row limit; use range paging
  // just in case, but 1000 rows in this window is the expected maximum).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (db as any)
    .from('paper_trades')
    .select('id, module, market_label, net_profit_usd, opened_at, suspect_duplicate')
    .eq('module', 'logic-arb')
    .gte('opened_at', WINDOW_START)
    .lt('opened_at', WINDOW_END)
    .order('opened_at', { ascending: true });

  if (error) {
    const msg = (error as { message?: string }).message ?? String(error);
    if (msg.includes('suspect_duplicate') || msg.includes('column')) {
      console.error('\nERROR: suspect_duplicate column not found.');
      console.error('Apply supabase/migrations/20260728000000_paper_trades_dedup.sql first.');
    } else {
      console.error('\nERROR fetching rows:', msg);
    }
    process.exit(1);
  }

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    console.log('No logic-arb rows found in the burst window. Nothing to mark.');
    return;
  }

  const allRows = rows as PaperTradeRow[];
  const totalRaw = allRows.length;

  // ── Identify duplicates ───────────────────────────────────────────────────
  // Group by (market_label, net_profit_usd). Within each group, the first row
  // (earliest opened_at, since we ordered asc) is the "canonical" trade.
  // Every subsequent row is a scan-cycle re-insert and should be flagged.

  const seenKey = new Map<string, string>();  // groupKey → first row id
  const suspectIds: string[] = [];

  for (const row of allRows) {
    if (row.suspect_duplicate) continue;  // already flagged; skip

    const profit = typeof row.net_profit_usd === 'number'
      ? row.net_profit_usd.toFixed(6)
      : String(row.net_profit_usd ?? '');
    const key = `${row.market_label}||${profit}`;

    if (!seenKey.has(key)) {
      seenKey.set(key, row.id);
    } else {
      suspectIds.push(row.id);
    }
  }

  // ── Diagnostic — before update ────────────────────────────────────────────
  const alreadyFlagged = allRows.filter(r => r.suspect_duplicate).length;
  const realCount      = totalRaw - alreadyFlagged - suspectIds.length;
  const realProfit     = allRows
    .filter(r => !r.suspect_duplicate && !suspectIds.includes(r.id))
    .reduce((acc, r) => acc + Number(r.net_profit_usd ?? 0), 0);
  const rawProfit      = allRows
    .reduce((acc, r) => acc + Number(r.net_profit_usd ?? 0), 0);

  console.log('──────────────────────────────────────────────────────');
  console.log('Diagnostic: logic-arb paper_trades (July 22–23 window)');
  console.log('──────────────────────────────────────────────────────');
  console.log(`  Raw rows in window   : ${totalRaw}`);
  console.log(`  Already flagged      : ${alreadyFlagged}`);
  console.log(`  New to flag this run : ${suspectIds.length}`);
  console.log(`  Real (canonical) rows: ${realCount}`);
  console.log('');
  console.log(`  Raw cumulative P&L   : $${rawProfit.toFixed(4)}`);
  console.log(`  Real cumulative P&L  : $${realProfit.toFixed(4)}`);
  console.log('');
  console.log('Unique (market_label, net_profit_usd) groups:');

  // Show per-group breakdown.
  const groups = new Map<string, { label: string; profit: number; count: number }>();
  for (const row of allRows) {
    const profit = Number(row.net_profit_usd ?? 0);
    const profitKey = profit.toFixed(6);
    const key = `${row.market_label}||${profitKey}`;
    const entry = groups.get(key) ?? { label: row.market_label, profit, count: 0 };
    entry.count++;
    groups.set(key, entry);
  }
  for (const [, g] of groups) {
    console.log(`    "${g.label}"  net=$${g.profit.toFixed(4)}  × ${g.count} rows`);
  }

  console.log('──────────────────────────────────────────────────────\n');

  if (suspectIds.length === 0) {
    console.log('Nothing new to flag. All duplicates are already marked.');
    return;
  }

  if (DRY_RUN) {
    console.log(`DRY RUN: would update ${suspectIds.length} rows → suspect_duplicate = true`);
    return;
  }

  // ── Update in batches of 100 (Supabase IN clause limit) ──────────────────
  const BATCH = 100;
  let updated = 0;

  for (let i = 0; i < suspectIds.length; i += BATCH) {
    const batch = suspectIds.slice(i, i + BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (db as any)
      .from('paper_trades')
      .update({ suspect_duplicate: true })
      .in('id', batch);

    if (updateErr) {
      console.error(`ERROR updating batch ${i}–${i + BATCH}:`, (updateErr as { message?: string }).message);
      process.exit(1);
    }
    updated += batch.length;
    console.log(`  Updated ${updated}/${suspectIds.length} rows…`);
  }

  console.log(`\nDone. Flagged ${suspectIds.length} rows as suspect_duplicate = true.`);
  console.log(`Real (non-duplicate) logic-arb P&L for the window: $${realProfit.toFixed(4)}`);
  console.log(`(Inflated figure was: $${rawProfit.toFixed(4)} across ${totalRaw} raw rows)\n`);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
