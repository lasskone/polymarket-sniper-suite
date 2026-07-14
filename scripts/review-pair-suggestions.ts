#!/usr/bin/env npx tsx
/**
 * Review pending correlated pair suggestions.
 *
 * Usage:
 *   tsx scripts/review-pair-suggestions.ts          # pending only (default)
 *   tsx scripts/review-pair-suggestions.ts --all    # all statuses
 *
 * This script is read-only. It never modifies any table.
 *
 * To approve a suggestion:
 *   tsx scripts/approve-pair-suggestion.ts <id>
 *
 * To reject (manual SQL):
 *   UPDATE correlated_pair_suggestions SET status = 'rejected' WHERE id = '<id>';
 */

import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

const showAll = process.argv.includes('--all');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = getSupabaseClient() as any;

interface SuggestionRow {
  id: string;
  market_a_question: string;
  market_b_question: string;
  market_a_slug: string;
  market_b_slug: string;
  relationship: 'a_implies_b' | 'mutually_exclusive';
  confidence: number;
  reasoning: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

async function main(): Promise<void> {
  let query = db
    .from('correlated_pair_suggestions')
    .select(
      'id, market_a_question, market_b_question, market_a_slug, market_b_slug, ' +
      'relationship, confidence, reasoning, status, created_at',
    )
    .order('confidence', { ascending: false });

  if (!showAll) {
    query = query.eq('status', 'pending');
  }

  const { data, error } = await query;
  if (error) {
    console.error('DB error:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as SuggestionRow[];

  if (rows.length === 0) {
    console.log(showAll ? '\nNo suggestions found.\n' : '\nNo pending suggestions.\n');
    console.log('Run tsx scripts/suggest-correlated-pairs.ts to generate candidates.\n');
    return;
  }

  const label = showAll ? `ALL (${rows.length})` : `PENDING (${rows.length})`;
  console.log(`\n${'─'.repeat(80)}`);
  console.log(` Correlated Pair Suggestions — ${label}`);
  console.log(`${'─'.repeat(80)}\n`);

  for (const row of rows) {
    const relLabel =
      row.relationship === 'a_implies_b'
        ? 'A ⟹  B  (a_implies_b)'
        : 'A ✗ B  (mutually_exclusive)';

    const confBar = '█'.repeat(Math.round(row.confidence * 10)).padEnd(10, '░');
    const date    = new Date(row.created_at).toISOString().slice(0, 10);

    console.log(`ID:           ${row.id}`);
    console.log(`Status:       ${row.status.toUpperCase()}   (created ${date})`);
    console.log(`Relationship: ${relLabel}`);
    console.log(`Confidence:   ${confBar}  ${(row.confidence * 100).toFixed(0)}%`);
    console.log(`Reasoning:    ${row.reasoning}`);
    console.log(`Market A:     ${row.market_a_question}`);
    console.log(`              slug: ${row.market_a_slug}`);
    console.log(`Market B:     ${row.market_b_question}`);
    console.log(`              slug: ${row.market_b_slug}`);
    console.log();
    console.log(`  Approve:  tsx scripts/approve-pair-suggestion.ts ${row.id}`);
    console.log(`  Reject:   UPDATE correlated_pair_suggestions SET status='rejected' WHERE id='${row.id}';`);
    console.log(`\n${'─'.repeat(80)}\n`);
  }

  const pending   = rows.filter((r) => r.status === 'pending').length;
  const approved  = rows.filter((r) => r.status === 'approved').length;
  const rejected  = rows.filter((r) => r.status === 'rejected').length;

  console.log(`Summary: ${pending} pending  ·  ${approved} approved  ·  ${rejected} rejected\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
