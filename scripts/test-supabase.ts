/**
 * scripts/test-supabase.ts
 *
 * Verifies the Supabase connection and confirms all expected tables exist.
 * Run with:   npm run test:supabase
 */

import { config } from 'dotenv';
config();  // load .env before anything else

import { getSupabaseClient } from '../modules/shared/supabase-client.js';

const EXPECTED_TABLES = [
  'trades',
  'opportunities',
  'performance',
  'risk_management',
  'market_snapshots',
] as const;

async function main(): Promise<void> {
  console.log('=== Supabase Connection Test ===\n');

  // ── 1. Env check ──────────────────────────────────────────────────────────
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('FAIL  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    console.error('      Copy .env.example → .env and fill in your credentials.');
    process.exit(1);
  }

  console.log(`  URL  : ${url}`);
  console.log(`  Key  : ${key.slice(0, 8)}... (${key.length} chars)\n`);

  // ── 2. Initialise client ──────────────────────────────────────────────────
  let client: ReturnType<typeof getSupabaseClient>;
  try {
    client = getSupabaseClient();
    console.log('  [OK] Client initialised.\n');
  } catch (err) {
    console.error(`  FAIL  Could not initialise client: ${err}`);
    process.exit(1);
  }

  // ── 3. Check each table ───────────────────────────────────────────────────
  console.log('  Checking tables:');
  let allOk = true;

  for (const table of EXPECTED_TABLES) {
    const { error } = await client
      .from(table)
      .select('id')
      .limit(1);

    if (error) {
      console.error(`  FAIL  ${table.padEnd(22)} — ${error.message}`);
      allOk = false;
    } else {
      console.log(`  [OK]  ${table}`);
    }
  }

  // ── 4. Insert + delete round-trip on trades ───────────────────────────────
  console.log('\n  Round-trip write test (trades):');
  const testRow = {
    module: '_test',
    market_id: '_test_market',
    side: 'BUY' as const,
    price: 0.5,
    size: 1,
    amount_usdc: 0.5,
    status: 'pending' as const,
    metadata: { test: true },
  };

  const { data: inserted, error: insertErr } = await client
    .from('trades')
    .insert(testRow)
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error(`  FAIL  Insert failed: ${insertErr?.message}`);
    allOk = false;
  } else {
    console.log(`  [OK]  Inserted test row  id=${inserted.id}`);

    const { error: deleteErr } = await client
      .from('trades')
      .delete()
      .eq('id', inserted.id);

    if (deleteErr) {
      console.error(`  FAIL  Delete failed: ${deleteErr.message}`);
      allOk = false;
    } else {
      console.log(`  [OK]  Deleted  test row  id=${inserted.id}`);
    }
  }

  // ── 5. Result ─────────────────────────────────────────────────────────────
  console.log('\n================================');
  if (allOk) {
    console.log('  RESULT: All checks passed.');
  } else {
    console.error('  RESULT: Some checks failed — see errors above.');
    console.error('  Have you applied supabase/schema.sql to your project?');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
