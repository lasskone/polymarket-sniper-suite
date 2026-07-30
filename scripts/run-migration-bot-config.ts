#!/usr/bin/env npx tsx
/**
 * One-time migration: create bot_config table and seed pair-discovery defaults.
 * Run: railway run npx tsx scripts/run-migration-bot-config.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const db = createClient(url, key);

async function main() {
  console.log('Running bot_config migration...');

  // Create table — Supabase REST doesn't expose DDL, so we use the RPC path
  // with a raw SQL execute if available, otherwise fall back to upsert-based
  // detection: try an insert and check the error code.

  // Attempt to upsert seed rows. If the table doesn't exist we'll get a
  // 42P01 error and can inform the user to create it via the Supabase SQL editor.
  const { error } = await (db as any)
    .from('bot_config')
    .upsert([
      { module: 'pair-discovery', key: 'enabled',        value: 'false' },
      { module: 'pair-discovery', key: 'interval_hours', value: '6'     },
    ], { onConflict: 'module,key', ignoreDuplicates: true });

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      console.error('\n⚠  bot_config table does not exist yet.');
      console.error('Run this SQL in the Supabase SQL editor:\n');
      console.error(`
CREATE TABLE IF NOT EXISTS bot_config (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  module     text        NOT NULL,
  key        text        NOT NULL,
  value      text        NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (module, key)
);

INSERT INTO bot_config (module, key, value) VALUES
  ('pair-discovery', 'enabled',        'false'),
  ('pair-discovery', 'interval_hours', '6')
ON CONFLICT (module, key) DO NOTHING;
`);
      process.exit(1);
    }
    console.error('Migration error:', error.message);
    process.exit(1);
  }

  // Verify
  const { data, error: readErr } = await (db as any)
    .from('bot_config')
    .select('module, key, value')
    .eq('module', 'pair-discovery');

  if (readErr) {
    console.error('Verify error:', readErr.message);
    process.exit(1);
  }

  console.log('\n✓ bot_config rows for pair-discovery:');
  for (const row of (data ?? []) as Array<{ module: string; key: string; value: string }>) {
    console.log(`  ${row.module}.${row.key} = ${row.value}`);
  }
  console.log('\nMigration complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
