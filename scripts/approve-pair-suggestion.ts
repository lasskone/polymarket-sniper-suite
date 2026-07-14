#!/usr/bin/env npx tsx
/**
 * Approve a correlated pair suggestion.
 *
 * Usage: tsx scripts/approve-pair-suggestion.ts <suggestion-id>
 *
 * What it does:
 *   1. Reads the suggestion row from `correlated_pair_suggestions`.
 *   2. Inserts the pair into `correlated_market_pairs` with active=true.
 *   3. Marks the suggestion as status='approved'.
 *
 * This is the ONLY way suggestions reach `correlated_market_pairs`. Nothing
 * runs this automatically — it requires an explicit CLI invocation with a
 * specific suggestion ID obtained by reviewing outputs of:
 *   tsx scripts/review-pair-suggestions.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { randomUUID }   from 'node:crypto';

const suggestionId = process.argv[2];
if (!suggestionId) {
  console.error('\nUsage: tsx scripts/approve-pair-suggestion.ts <suggestion-id>\n');
  console.error('Get suggestion IDs from: tsx scripts/review-pair-suggestions.ts\n');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\n❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = createClient(SUPABASE_URL, SUPABASE_KEY) as any;

async function main(): Promise<void> {
  // ── Read suggestion ───────────────────────────────────────────────────────

  const { data: suggestion, error: readErr } = await db
    .from('correlated_pair_suggestions')
    .select('*')
    .eq('id', suggestionId)
    .single();

  if (readErr || !suggestion) {
    console.error(`\n❌  Suggestion not found: ${suggestionId}\n`);
    console.error('Run tsx scripts/review-pair-suggestions.ts to list valid IDs.\n');
    process.exit(1);
  }

  if (suggestion.status !== 'pending') {
    console.error(
      `\n❌  Suggestion is already ${suggestion.status.toUpperCase()}.\n` +
      '    Only pending suggestions can be approved.\n',
    );
    process.exit(1);
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  console.log('\n══ Approving suggestion ══════════════════════════════════════════════════\n');
  console.log(`ID:           ${suggestion.id}`);
  console.log(`Relationship: ${suggestion.relationship}`);
  console.log(`Confidence:   ${(suggestion.confidence * 100).toFixed(0)}%`);
  console.log(`Reasoning:    ${suggestion.reasoning}`);
  console.log(`Market A:     ${suggestion.market_a_question}`);
  console.log(`Market B:     ${suggestion.market_b_question}`);
  console.log();

  // ── Insert into correlated_market_pairs ──────────────────────────────────

  const { error: insertErr } = await db
    .from('correlated_market_pairs')
    .insert({
      id:                       randomUUID(),
      market_a_condition_id:    suggestion.market_a_condition_id,
      market_b_condition_id:    suggestion.market_b_condition_id,
      market_a_slug:            suggestion.market_a_slug,
      market_b_slug:            suggestion.market_b_slug,
      relationship:             suggestion.relationship,
      notes:                    suggestion.reasoning,
      active:                   true,
    });

  if (insertErr) {
    if (insertErr.code === '23505') {
      console.error('❌  This pair already exists in correlated_market_pairs.\n');
    } else {
      console.error(`❌  Insert failed: ${insertErr.message}\n`);
    }
    process.exit(1);
  }

  // ── Mark suggestion as approved ───────────────────────────────────────────

  const { error: updateErr } = await db
    .from('correlated_pair_suggestions')
    .update({ status: 'approved' })
    .eq('id', suggestionId);

  if (updateErr) {
    console.error(
      `⚠️   Pair inserted into correlated_market_pairs but suggestion status update failed: ` +
      `${updateErr.message}\n` +
      `    Manually run: UPDATE correlated_pair_suggestions SET status='approved' WHERE id='${suggestionId}';\n`,
    );
    process.exit(1);
  }

  console.log('✅  Pair added to correlated_market_pairs with active=true.');
  console.log('    LogicArb will pick it up on its next scan cycle.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
