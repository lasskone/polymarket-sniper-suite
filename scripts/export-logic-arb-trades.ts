#!/usr/bin/env npx tsx
/**
 * Export Logic-Arb Paper Trades to CSV
 *
 * Read-only — no data is modified.
 *
 * Run via:
 *   railway run tsx scripts/export-logic-arb-trades.ts           # plaintext CSV
 *   railway run tsx scripts/export-logic-arb-trades.ts --base64  # base64-encoded CSV
 *   tsx scripts/export-logic-arb-trades.ts                       # local (needs .env)
 *
 * Output (stdout):
 *   1. Summary table grouped by market pair: avg deviation, avg $ invested, avg profit, count.
 *   2. Full CSV of all non-suspect logic-arb paper_trades (suspect_duplicate = false).
 *      With --base64 the CSV block is base64-encoded for safe copy-paste from a log stream.
 *
 * CSV columns:
 *   trade_id, opened_at, market_pair_label, relationship,
 *   priceA, priceB,
 *   legA_action, legB_action,          ← explicit human-readable action per leg
 *   legA_fill_price, legB_fill_price,  ← actual price paid per share on each leg
 *   legA_notional_usd, legB_notional_usd, total_notional_usd,  ← 10 shares × fill price
 *   deviation,                         ← priceA-priceB (a_implies_b) | priceA+priceB-1 (mut_excl)
 *   fee_rate, net_profit_usd
 *
 * Leg derivation rules (deterministic from relationship type):
 *   a_implies_b      → legA: Buy NO on Market A  (fill price = 1 − priceA)
 *                      legB: Buy YES on Market B (fill price = priceB)
 *   mutually_exclusive → legA: Buy NO on Market A  (fill price = 1 − priceA)
 *                        legB: Buy NO on Market B  (fill price = 1 − priceB)
 */

import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Relationship = 'a_implies_b' | 'mutually_exclusive';

interface TradeMetadata {
  relationship:       Relationship;
  priceA:             number;
  priceB:             number;
  deviation:          number;
  feeRate:            number;
  shares:             number;
  netProfitUSD:       number;
  marketASlug:        string;
  marketBSlug:        string;
  pairId:             string;
  marketAConditionId: string;
  marketBConditionId: string;
  trade: {
    legA: { token: 'YES' | 'NO'; price: number };
    legB: { token: 'YES' | 'NO'; price: number };
  };
}

interface PaperTradeRow {
  id:             string;
  opened_at:      string;
  market_label:   string;
  net_profit_usd: string | number | null;
  shares:         string | number;
  metadata:       TradeMetadata | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SHARES_PER_LEG = 10;

const CSV_HEADER = [
  'trade_id',
  'opened_at',
  'market_pair_label',
  'relationship',
  'priceA',
  'priceB',
  'legA_action',
  'legB_action',
  'legA_fill_price',
  'legB_fill_price',
  'legA_notional_usd',
  'legB_notional_usd',
  'total_notional_usd',
  'deviation',
  'fee_rate',
  'net_profit_usd',
].join(',');

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Derives which token is bought on each leg and the fill price paid per share.
 *
 * a_implies_b:
 *   - Market A: Buy NO  at (1 − priceA)   ← bet against the over-priced side
 *   - Market B: Buy YES at priceB          ← cheaper than A despite B being guaranteed ≥ A
 *
 * mutually_exclusive:
 *   - Market A: Buy NO  at (1 − priceA)   ← short both sides of the over-sum pair
 *   - Market B: Buy NO  at (1 − priceB)
 */
function deriveLegDetails(
  relationship: Relationship,
  priceA: number,
  priceB: number,
): {
  legA_action:     string;
  legB_action:     string;
  legA_fill_price: number;
  legB_fill_price: number;
} {
  if (relationship === 'a_implies_b') {
    return {
      legA_action:     'Buy NO on Market A',
      legB_action:     'Buy YES on Market B',
      legA_fill_price: 1 - priceA,
      legB_fill_price: priceB,
    };
  }
  return {
    legA_action:     'Buy NO on Market A',
    legB_action:     'Buy NO on Market B',
    legA_fill_price: 1 - priceA,
    legB_fill_price: 1 - priceB,
  };
}

/**
 * Mispricing magnitude derived from first principles.
 * a_implies_b:       priceA − priceB           (positive when pA > pB)
 * mutually_exclusive: priceA + priceB − 1       (positive when sum > 1)
 */
function deriveDeviation(relationship: Relationship, priceA: number, priceB: number): number {
  return relationship === 'a_implies_b'
    ? priceA - priceB
    : priceA + priceB - 1;
}

/** Wraps a CSV field value in quotes if it contains commas, quotes, or newlines. */
function csvField(value: string | number | null | undefined): string {
  const s = String(value ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function buildCsvRow(row: PaperTradeRow): string | null {
  const meta = row.metadata;
  if (!meta) return null;

  const { relationship, priceA, priceB, feeRate } = meta;
  const { legA_action, legB_action, legA_fill_price, legB_fill_price } =
    deriveLegDetails(relationship, priceA, priceB);

  const legA_notional   = SHARES_PER_LEG * legA_fill_price;
  const legB_notional   = SHARES_PER_LEG * legB_fill_price;
  const total_notional  = legA_notional + legB_notional;

  // Prefer the stored deviation; fall back to deriving it (guards against old rows).
  const deviation = typeof meta.deviation === 'number'
    ? meta.deviation
    : deriveDeviation(relationship, priceA, priceB);

  const net_profit = Number(row.net_profit_usd ?? meta.netProfitUSD ?? 0);

  return [
    row.id,
    row.opened_at,
    row.market_label,
    relationship,
    priceA.toFixed(4),
    priceB.toFixed(4),
    legA_action,
    legB_action,
    legA_fill_price.toFixed(4),
    legB_fill_price.toFixed(4),
    legA_notional.toFixed(4),
    legB_notional.toFixed(4),
    total_notional.toFixed(4),
    deviation.toFixed(4),
    feeRate.toFixed(4),
    net_profit.toFixed(6),
  ].map(csvField).join(',');
}

// ── Supabase pagination ────────────────────────────────────────────────────────

async function fetchAllRows(db: ReturnType<typeof getSupabaseClient>): Promise<PaperTradeRow[]> {
  const PAGE     = 1000;
  const allRows: PaperTradeRow[] = [];
  let from       = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: page, error } = await (db as any)
      .from('paper_trades')
      .select('id, opened_at, market_label, net_profit_usd, shares, metadata')
      .eq('module', 'logic-arb')
      .eq('suspect_duplicate', false)
      .order('opened_at', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      console.error('ERROR fetching rows:', msg);
      process.exit(1);
    }

    if (!page || !Array.isArray(page) || page.length === 0) break;
    allRows.push(...(page as PaperTradeRow[]));
    if (page.length < PAGE) break;  // last page
    from += PAGE;
  }

  return allRows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db        = getSupabaseClient();
  const BASE64    = process.argv.includes('--base64');

  console.log('export-logic-arb-trades — fetching non-suspect logic-arb paper_trades…\n');

  const rows = await fetchAllRows(db);
  console.log(`Fetched ${rows.length} rows.\n`);

  if (rows.length === 0) {
    console.log('No rows found — nothing to export.');
    process.exit(0);
  }

  // ── Build CSV ───────────────────────────────────────────────────────────────

  const csvLines: string[] = [CSV_HEADER];
  let skipped = 0;

  for (const row of rows) {
    const line = buildCsvRow(row);
    if (line === null) { skipped++; continue; }
    csvLines.push(line);
  }

  if (skipped > 0) {
    console.log(`Warning: ${skipped} rows had null metadata and were skipped.\n`);
  }

  // ── Summary grouped by market pair ─────────────────────────────────────────

  interface PairStats {
    label:         string;
    count:         number;
    totalDev:      number;
    totalInvested: number;
    totalProfit:   number;
    relationships: Set<Relationship>;
  }

  const pairMap = new Map<string, PairStats>();

  for (const row of rows) {
    const meta = row.metadata;
    if (!meta) continue;

    const { relationship, priceA, priceB } = meta;
    const { legA_fill_price, legB_fill_price } = deriveLegDetails(relationship, priceA, priceB);

    const totalInvested = SHARES_PER_LEG * (legA_fill_price + legB_fill_price);
    const deviation     = typeof meta.deviation === 'number'
      ? meta.deviation
      : deriveDeviation(relationship, priceA, priceB);
    const profit = Number(row.net_profit_usd ?? meta.netProfitUSD ?? 0);

    const entry = pairMap.get(row.market_label) ?? {
      label: row.market_label,
      count: 0,
      totalDev: 0,
      totalInvested: 0,
      totalProfit: 0,
      relationships: new Set<Relationship>(),
    };
    entry.count++;
    entry.totalDev      += deviation;
    entry.totalInvested += totalInvested;
    entry.totalProfit   += profit;
    entry.relationships.add(relationship);
    pairMap.set(row.market_label, entry);
  }

  const summaryRows = Array.from(pairMap.values()).sort((a, b) => b.count - a.count);

  const COL_LABEL = 55;
  const divider   = '═'.repeat(COL_LABEL + 60);

  console.log(divider);
  console.log('  LOGIC-ARB PAPER TRADES — SUMMARY BY MARKET PAIR');
  console.log(divider);
  console.log(
    `  ${'Market Pair'.padEnd(COL_LABEL)}  ` +
    `${'Cnt'.padStart(4)}  ${'Relationship'.padEnd(18)}  ` +
    `${'Avg Deviation'.padStart(13)}  ${'Avg Invested'.padStart(12)}  ${'Avg Profit'.padStart(10)}`,
  );
  console.log('  ' + '─'.repeat(COL_LABEL + 58));

  let grandCount    = 0;
  let grandDev      = 0;
  let grandInvested = 0;
  let grandProfit   = 0;

  for (const s of summaryRows) {
    const avgDev      = s.totalDev      / s.count;
    const avgInvested = s.totalInvested / s.count;
    const avgProfit   = s.totalProfit   / s.count;
    const relLabel    = Array.from(s.relationships).join('/');

    grandCount    += s.count;
    grandDev      += s.totalDev;
    grandInvested += s.totalInvested;
    grandProfit   += s.totalProfit;

    console.log(
      `  ${s.label.slice(0, COL_LABEL).padEnd(COL_LABEL)}  ` +
      `${String(s.count).padStart(4)}  ${relLabel.padEnd(18)}  ` +
      `${(avgDev * 100).toFixed(2).padStart(10)}%    ` +
      `$${avgInvested.toFixed(2).padStart(10)}  ` +
      `$${avgProfit.toFixed(4).padStart(9)}`,
    );
  }

  console.log('  ' + '─'.repeat(COL_LABEL + 58));
  const grandAvgDev      = grandDev / grandCount;
  const grandAvgInvested = grandInvested / grandCount;
  const grandAvgProfit   = grandProfit / grandCount;
  console.log(
    `  ${'TOTAL / AVG'.padEnd(COL_LABEL)}  ` +
    `${String(grandCount).padStart(4)}  ${''.padEnd(18)}  ` +
    `${(grandAvgDev * 100).toFixed(2).padStart(10)}%    ` +
    `$${grandAvgInvested.toFixed(2).padStart(10)}  ` +
    `$${grandAvgProfit.toFixed(4).padStart(9)}`,
  );
  console.log(divider);
  console.log(`\n  Exported rows  : ${csvLines.length - 1}`);
  console.log(`  Total net P&L  : $${grandProfit.toFixed(4)}`);
  console.log(`  Total invested : $${grandInvested.toFixed(4)}`);
  console.log(`  Pairs observed : ${pairMap.size}\n`);

  // ── CSV output ──────────────────────────────────────────────────────────────

  const csvContent = csvLines.join('\n');

  if (BASE64) {
    const b64 = Buffer.from(csvContent, 'utf8').toString('base64');
    console.log('━━━ CSV_BASE64_START ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(b64);
    console.log('━━━ CSV_BASE64_END ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('To decode on your machine:');
    console.log("  Copy the base64 block above between the START/END markers, then:");
    console.log('  echo "<paste-base64-here>" | base64 -d > logic-arb-trades.csv');
    console.log('  open logic-arb-trades.csv');
  } else {
    console.log('━━━ CSV_START ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(csvContent);
    console.log('━━━ CSV_END ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('Tip: re-run with --base64 to get a base64-encoded block for easy copy-paste.');
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
