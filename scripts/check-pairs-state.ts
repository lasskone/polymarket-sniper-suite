#!/usr/bin/env npx tsx
import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

async function main() {
  const db = getSupabaseClient();
  const { data, error } = await (db as any)
    .from('correlated_market_pairs')
    .select('market_a_slug, market_b_slug, active')
    .order('active', { ascending: false });

  if (error) { console.error('ERROR:', error.message); process.exit(1); }

  console.log('\n=== correlated_market_pairs final state ===\n');
  const active   = (data as any[]).filter(r =>  r.active);
  const inactive = (data as any[]).filter(r => !r.active);

  console.log('ACTIVE (' + active.length + '):');
  for (const r of active) console.log('  ✓ ' + r.market_a_slug);
  console.log('\nINACTIVE (' + inactive.length + '):');
  for (const r of inactive) console.log('  ✗ ' + r.market_a_slug);
  console.log('');
}
main().catch(e => { console.error(e); process.exit(1); });
