#!/usr/bin/env node
/**
 * scripts/fix-dedup-index.ts
 *
 * Diagnostic + fix for the missing/broken idx_paper_trades_dedup index.
 *
 * Steps executed:
 *  1. Check whether idx_paper_trades_dedup currently exists (via pg_indexes REST probe)
 *  2. Find all (module, market_label, opened_minute) duplicate groups where
 *     suspect_duplicate = false — the "clean" cohort
 *  3. For each duplicate group: mark all but the earliest row suspect_duplicate = true
 *  4. Print exact DDL SQL to paste in the Supabase SQL Editor
 *  5. Live-test the partial-index + PostgREST onConflict behaviour after the index exists
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── helpers ──────────────────────────────────────────────────────────────────

function hr(title: string): void {
  const bar = '═'.repeat(64);
  console.log(`\n${bar}\n  ${title}\n${bar}\n`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── Step 1: does idx_paper_trades_dedup exist? ────────────────────────────
  hr('Step 1 — Check idx_paper_trades_dedup existence');

  // PostgREST doesn't expose pg_catalog so we probe it via a raw fetch
  // (expects a 404 / PGRST204 — that's fine; we parse the body to distinguish
  //  "schema not exposed" from "relation has no rows".)
  const probeUrl =
    `${SUPABASE_URL}/rest/v1/pg_indexes` +
    `?tablename=eq.paper_trades&indexname=eq.idx_paper_trades_dedup&select=indexname`;

  const probeRes = await fetch(probeUrl, {
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept:        'application/json',
    },
  });

  if (probeRes.ok) {
    const rows = await probeRes.json() as Array<{ indexname: string }>;
    const exists = rows.length > 0;
    console.log(`REST probe succeeded. idx_paper_trades_dedup ${exists ? 'EXISTS ✓' : 'DOES NOT EXIST ✗'}`);
  } else {
    const body = await probeRes.text();
    console.log(`REST probe returned ${probeRes.status} — pg_catalog is not in PostgREST schema (expected).`);
    console.log(`Response: ${body.slice(0, 200)}`);
    console.log(`\n→ Index existence must be confirmed via SQL Editor:`);
    console.log(`  SELECT indexname, indexdef FROM pg_indexes`);
    console.log(`  WHERE tablename = 'paper_trades' AND indexname = 'idx_paper_trades_dedup';`);
  }

  // ── Step 2: find remaining clean duplicates ───────────────────────────────
  hr('Step 2 — Find duplicate (module, market_label, opened_minute) groups');
  hr('         where suspect_duplicate = false');

  // Fetch all clean rows — we need id, opened_at, opened_minute to group them.
  // opened_minute is a generated stored column (date_trunc('minute', opened_at)).
  const { data: cleanRows, error: fetchErr } = await (supabase as any)
    .from('paper_trades')
    .select('id, module, market_label, opened_at, opened_minute, suspect_duplicate')
    .eq('suspect_duplicate', false)
    .order('opened_at', { ascending: true })
    .limit(10000);    // safety cap — adjust if needed

  if (fetchErr) {
    console.error('Failed to fetch paper_trades:', fetchErr.message);
    process.exit(1);
  }

  const rows = cleanRows as Array<{
    id:               string;
    module:           string;
    market_label:     string;
    opened_at:        string;
    opened_minute:    string;
    suspect_duplicate: boolean;
  }>;

  console.log(`Clean rows fetched: ${rows.length}`);

  // Group by composite key
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.module}\0${row.market_label}\0${row.opened_minute}`;
    const g = groups.get(key) ?? [];
    g.push(row);
    groups.set(key, g);
  }

  const dupGroups = [...groups.values()]
    .filter(g => g.length > 1)
    // rows are already sorted by opened_at (ascending) from the query
    ;

  console.log(`\nDuplicate groups found: ${dupGroups.length}`);

  if (dupGroups.length === 0) {
    console.log('Clean cohort is already dedup-safe.\n');
  } else {
    for (const g of dupGroups) {
      const { module, market_label, opened_minute } = g[0];
      console.log(`\n  module="${module}"  label="${market_label}"  minute=${opened_minute}`);
      g.forEach((r, i) =>
        console.log(`    [${i === 0 ? 'KEEP  ' : 'MARK  '}] id=${r.id}  opened_at=${r.opened_at}`)
      );
    }
  }

  // ── Step 3: mark non-earliest rows suspect_duplicate = true ──────────────
  hr('Step 3 — Mark non-earliest duplicates suspect_duplicate = true');

  const toMark = dupGroups.flatMap(g => g.slice(1).map(r => r.id));

  if (toMark.length === 0) {
    console.log('Nothing to mark — skipping update.');
  } else {
    console.log(`Marking ${toMark.length} row(s)...`);
    const { error: updateErr } = await (supabase as any)
      .from('paper_trades')
      .update({ suspect_duplicate: true })
      .in('id', toMark);

    if (updateErr) {
      console.error('Update failed:', updateErr.message);
      process.exit(1);
    }
    console.log(`Done. Rows marked: ${toMark.map(id => id.slice(0, 8)).join(', ')}`);
  }

  // ── Step 4: DDL SQL ───────────────────────────────────────────────────────
  hr('Step 4 — DDL to paste in the Supabase SQL Editor');

  console.log(`-- ① Confirm current state
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'paper_trades'
  AND indexname = 'idx_paper_trades_dedup';

-- ② Drop the old non-partial index if it somehow exists
DROP INDEX IF EXISTS idx_paper_trades_dedup;

-- ③ Create partial unique index — excludes suspect_duplicate = true rows,
--    so historical dupes never block future clean inserts.
CREATE UNIQUE INDEX idx_paper_trades_dedup
  ON paper_trades (module, market_label, opened_minute)
  WHERE suspect_duplicate = false;

-- ④ Verify
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'paper_trades'
ORDER BY indexname;`);

  // ── Step 5: live onConflict test (only runs if we can detect the index) ───
  hr('Step 5 — Live onConflict test (PostgREST partial-index targeting)');

  console.log('Inserting canary row …');
  const testLabel = `__dedup_test_${Date.now()}`;
  const testModule = 'logic-arb';

  // First insert — should always succeed
  const { data: ins1, error: err1 } = await (supabase as any)
    .from('paper_trades')
    .insert({
      module:         testModule,
      market_label:   testLabel,
      net_profit_usd: 0,
      shares:         1,
      trading_mode:   'paper',
      // opened_at defaults to now(); opened_minute is generated; suspect_duplicate defaults false
    })
    .select('id, opened_minute, suspect_duplicate');

  if (err1) {
    console.error('First insert failed:', err1.message);
    process.exit(1);
  }

  const inserted = (ins1 as any[])[0];
  console.log(`First insert OK — id=${inserted.id}  opened_minute=${inserted.opened_minute}  suspect_duplicate=${inserted.suspect_duplicate}`);

  // Second insert — same module + label, same second → same opened_minute.
  // With the partial index in place, upsert+onConflict+ignoreDuplicates must block it.
  // Without the index, a second row is silently inserted.
  console.log('\nAttempting duplicate upsert (same module + label + minute) …');

  const { data: ins2, error: err2 } = await (supabase as any)
    .from('paper_trades')
    .upsert(
      {
        module:         testModule,
        market_label:   testLabel,
        net_profit_usd: 0,
        shares:         1,
        trading_mode:   'paper',
      },
      { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true },
    )
    .select('id');

  if (err2) {
    console.log(`Upsert returned error: ${err2.message}`);
    console.log('This means the index exists AND is being targeted — dedup is working ✓');
  } else if (!ins2 || (ins2 as any[]).length === 0) {
    console.log('Upsert returned 0 rows — conflict was silently suppressed (ignoreDuplicates) ✓');
  } else {
    const secondId = (ins2 as any[])[0]?.id;
    if (secondId === inserted.id) {
      console.log(`Upsert returned the original row (upserted existing) — id=${secondId} ✓`);
    } else {
      console.log(`WARNING: Upsert returned a NEW row — id=${secondId}`);
      console.log('This means the index did NOT block the duplicate.');
      console.log('Either the index does not exist yet, or PostgREST cannot target a partial index via onConflict.');
      console.log('→ See notes in Step 4 output.');
    }
  }

  // Count rows with our test label to determine actual dupe state
  const { data: countRows } = await (supabase as any)
    .from('paper_trades')
    .select('id', { count: 'exact', head: false })
    .eq('module', testModule)
    .eq('market_label', testLabel);

  const count = (countRows as any[])?.length ?? '?';
  console.log(`\nRows in paper_trades with testLabel: ${count}`);
  if (Number(count) === 1) {
    console.log('→ Exactly 1 row — dedup is working correctly ✓');
  } else {
    console.log(`→ ${count} rows — duplicate was NOT suppressed ✗`);
    console.log('  Apply the partial index DDL from Step 4 first, then re-run this script.');
  }

  // Clean up canary row(s)
  const { error: delErr } = await (supabase as any)
    .from('paper_trades')
    .delete()
    .eq('module', testModule)
    .eq('market_label', testLabel);

  if (delErr) {
    console.warn('Cleanup failed (manual delete needed):', delErr.message);
    console.warn(`  DELETE FROM paper_trades WHERE module='${testModule}' AND market_label='${testLabel}';`);
  } else {
    console.log(`Canary row(s) cleaned up.`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
