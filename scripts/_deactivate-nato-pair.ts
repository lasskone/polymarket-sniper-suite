import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

const FULL_ID = 'c6ac5264-77e5-4aca-ab4d-f0b905341a0d';

async function main() {
  // 1. Verify before update
  const { data: row, error: fetchErr } = await (sb as any)
    .from('correlated_market_pairs')
    .select('id, market_a_slug, market_b_slug, market_a_condition_id, market_b_condition_id, active')
    .eq('id', FULL_ID)
    .single();

  if (fetchErr) { console.error('Fetch ERR:', fetchErr.message); process.exit(1); }
  console.log('Pre-update:', JSON.stringify(row, null, 2));

  const isNatoPair =
    row.market_a_slug.includes('havrylivka') &&
    row.market_b_slug.includes('nato');
  if (!isNatoPair) {
    console.error('Row does not match Russia/Havrylivka→NATO pattern — aborting, no changes made.');
    process.exit(1);
  }

  // 2. Deactivate
  const { error: updErr } = await (sb as any)
    .from('correlated_market_pairs')
    .update({ active: false })
    .eq('id', FULL_ID);
  console.log('\nDeactivate:', updErr ? 'ERR: ' + updErr.message : 'active=false ✓');

  // 3. Reject corresponding suggestion
  const { data: sugg, error: sErr } = await (sb as any)
    .from('correlated_pair_suggestions')
    .select('id, status')
    .eq('market_a_condition_id', row.market_a_condition_id)
    .eq('market_b_condition_id', row.market_b_condition_id)
    .in('status', ['approved', 'pending']);

  if (sErr) { console.log('Suggestion fetch ERR:', sErr.message); }
  else if (!sugg || (sugg as any[]).length === 0) {
    console.log('No approved/pending suggestion found for this pair.');
  } else {
    for (const s of sugg as any[]) {
      const { error: rErr } = await (sb as any)
        .from('correlated_pair_suggestions')
        .update({ status: 'rejected' })
        .eq('id', s.id);
      console.log(`Suggestion ${s.id.slice(0, 8)} was ${s.status} → ${rErr ? 'ERR: ' + rErr.message : 'rejected ✓'}`);
    }
  }

  // 4. Final active count
  const { count, error: cErr } = await (sb as any)
    .from('correlated_market_pairs')
    .select('*', { count: 'exact', head: true })
    .eq('active', true);
  console.log('\nFinal active pair count:', cErr ? 'ERR: ' + cErr.message : count);
}

main().catch(err => { console.error(err); process.exit(1); });
