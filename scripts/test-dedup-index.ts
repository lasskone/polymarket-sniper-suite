/**
 * scripts/test-dedup-index.ts
 *
 * Run AFTER applying supabase/migrations/20260730000001_dedup_partial_index.sql.
 *
 * Verifies the partial unique index idx_paper_trades_dedup and the insert+23505
 * pattern used by bot/index.ts (PostgREST cannot target a partial index via
 * onConflict without a WHERE clause, so we use plain .insert() and treat 23505
 * unique_violation as a non-error instead).
 *
 *  A. First insert succeeds.
 *  B. Duplicate insert within the same minute returns 23505 (not a different error,
 *     not a silent second row).
 *  C. Insert with a different label succeeds (not over-blocking).
 *  D. Row with suspect_duplicate=true does NOT conflict with a fresh clean insert
 *     for the same label+minute (partial index excludes suspect rows).
 *
 * Usage:
 *   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=ey... npx tsx scripts/test-dedup-index.ts
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL             = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('env vars missing'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function pass(msg: string): void { console.log(`  ✓  ${msg}`); }
function fail(msg: string): void { console.log(`  ✗  ${msg}`); process.exitCode = 1; }

async function cleanup(label: string): Promise<void> {
  await (supabase as any).from('paper_trades').delete().eq('market_label', label);
}

async function main(): Promise<void> {
  console.log('\nDedup index test suite\n');
  const label = `__dedup_test_${Date.now()}`;

  try {
    // ── A. First insert — must succeed ───────────────────────────────────────
    console.log('A. First insert (expect: OK)');
    const { data: a1, error: e1 } = await (supabase as any)
      .from('paper_trades')
      .insert({ module: 'logic-arb', market_label: label, net_profit_usd: 0, shares: 1, trading_mode: 'paper' })
      .select('id, opened_minute, suspect_duplicate');
    if (e1) { fail(`First insert errored: ${e1.message}`); return; }
    const row1 = (a1 as any[])[0];
    pass(`Inserted id=${row1.id.slice(0,8)}  minute=${row1.opened_minute}  suspect=${row1.suspect_duplicate}`);

    // ── B. Duplicate insert within same minute — must return 23505 ───────────
    // bot/index.ts uses plain .insert() and suppresses 23505. The partial index
    // idx_paper_trades_dedup (WHERE suspect_duplicate = false) enforces uniqueness.
    // PostgREST returns 23505 as an error object with code='23505'.
    console.log('\nB. Duplicate insert same minute (expect: 23505 unique_violation, NOT a second row)');
    const { error: e2 } = await (supabase as any)
      .from('paper_trades')
      .insert({ module: 'logic-arb', market_label: label, net_profit_usd: 0, shares: 1, trading_mode: 'paper' });

    if (!e2) {
      // No error — check if a second row was actually inserted
      const { data: countRows } = await (supabase as any)
        .from('paper_trades').select('id').eq('market_label', label).eq('suspect_duplicate', false);
      const count = (countRows as any[]).length;
      if (count === 1) {
        fail('Duplicate insert returned no error and no second row — index may not exist (dedup is silently broken)');
      } else {
        fail(`Duplicate insert succeeded and added a second row — index MISSING, ${count} rows in DB`);
      }
    } else if (e2.code === '23505') {
      pass(`Got 23505 unique_violation — index exists and is enforcing dedup ✓`);
      pass(`bot/index.ts suppresses this code: paper trade recording is working correctly`);
    } else {
      fail(`Unexpected error (code=${e2.code}): ${e2.message}`);
      if (e2.message?.includes('no unique or exclusion constraint')) {
        console.log('     → Index does not exist yet. Apply the migration SQL first:');
        console.log('       supabase/migrations/20260730000001_dedup_partial_index.sql');
      }
    }

    // ── C. Insert with different label must succeed (not over-blocking) ──────
    console.log('\nC. Different label insert (expect: OK, not over-blocked)');
    const label2 = `${label}_other`;
    const { error: e3 } = await (supabase as any)
      .from('paper_trades')
      .insert({ module: 'logic-arb', market_label: label2, net_profit_usd: 0, shares: 1, trading_mode: 'paper' });
    if (e3) { fail(`Different-label insert errored (code=${e3.code}): ${e3.message}`); }
    else     { pass('Different-label insert succeeded'); }
    await cleanup(label2);

    // ── D. Row with suspect_duplicate=true must not block a clean insert ──────
    console.log('\nD. suspect_duplicate=true row must not conflict with a new clean row (same label+minute)');
    // Mark the existing row suspect — it falls outside the partial index predicate.
    await (supabase as any).from('paper_trades').update({ suspect_duplicate: true }).eq('id', row1.id);

    const { error: e4 } = await (supabase as any)
      .from('paper_trades')
      .insert({ module: 'logic-arb', market_label: label, net_profit_usd: 0, shares: 1, trading_mode: 'paper' });

    if (!e4) {
      // New clean row inserted — verify it landed
      const { data: allRows } = await (supabase as any)
        .from('paper_trades').select('id, suspect_duplicate').eq('market_label', label);
      const cleanRows = (allRows as any[]).filter((r: any) => !r.suspect_duplicate);
      if (cleanRows.length === 1) {
        pass(`New clean row inserted alongside suspect row — partial index correctly excludes suspect rows ✓`);
      } else {
        fail(`Expected 1 clean row, found ${cleanRows.length}`);
      }
    } else if (e4.code === '23505') {
      fail(`suspect_duplicate=true row caused a 23505 conflict — index predicate is wrong (not partial)`);
    } else {
      fail(`Insert after marking suspect errored (code=${e4.code}): ${e4.message}`);
    }

  } finally {
    await cleanup(label);
    console.log('\nCanary rows cleaned up.');
  }
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
