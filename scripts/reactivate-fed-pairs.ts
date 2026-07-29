#!/usr/bin/env npx tsx
/**
 * Reactivate Fed-rate correlated_market_pairs
 *
 * Context: The logic-arb service was using conditionId-based Gamma API lookup
 * (unreliable — silently returns a fallback market for any conditionId not
 * indexed).  This caused isValidMarket() to incorrectly deactivate all 10 pairs
 * including the 5 Fed-rate pairs that were confirmed open via slug-based lookup.
 *
 * The service has since been fixed to use slug-based lookup.  This script
 * reactivates the 5 falsely-deactivated Fed-rate pairs so they are included in
 * future scans.
 *
 * Run locally:
 *   npx tsx scripts/reactivate-fed-pairs.ts [--dry-run]
 * Or on Railway:
 *   railway run npx tsx scripts/reactivate-fed-pairs.ts
 */

import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const db = getSupabaseClient();

  console.log(`reactivate-fed-pairs${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // Fetch all Fed-rate pairs regardless of active state.
  const { data: pairs, error } = await (db as any)
    .from('correlated_market_pairs')
    .select('id, market_a_slug, market_b_slug, active')
    .ilike('market_a_slug', '%fed%');

  if (error) {
    console.error('ERROR fetching pairs:', error.message);
    process.exit(1);
  }

  if (!pairs?.length) {
    console.log('No Fed-rate pairs found in the DB.');
    return;
  }

  console.log(`Found ${pairs.length} Fed-rate pair(s):\n`);

  for (const p of pairs as Array<{ id: string; market_a_slug: string; market_b_slug: string; active: boolean }>) {
    const status = p.active ? 'ACTIVE' : 'inactive';
    console.log(`  [${status}] ${p.market_a_slug}`);
    console.log(`           ${p.market_b_slug}`);
  }
  console.log();

  const inactivePairs = (pairs as Array<{ id: string; market_a_slug: string; market_b_slug: string; active: boolean }>)
    .filter(p => !p.active);

  if (inactivePairs.length === 0) {
    console.log('All Fed-rate pairs are already active. Nothing to do.');
    return;
  }

  console.log(`Will reactivate ${inactivePairs.length} pair(s):`);
  for (const p of inactivePairs) {
    console.log(`  ${p.market_a_slug}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes made.');
    return;
  }

  const ids = inactivePairs.map(p => p.id);
  const { error: updateError } = await (db as any)
    .from('correlated_market_pairs')
    .update({ active: true })
    .in('id', ids);

  if (updateError) {
    console.error('\nERROR updating pairs:', updateError.message);
    process.exit(1);
  }

  console.log(`\nDone — reactivated ${inactivePairs.length} Fed-rate pair(s).`);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
