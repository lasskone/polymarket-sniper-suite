import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

const OIL_IDS = [
  '621eb2c6-eb97-4576-8ee5-3ec28c8fae27',
  'cf26e25b-5ea8-4418-ac7e-94b500a3ef36',
  '40f8532a-3525-4b07-a9ed-6cd4f7156fed',
  '8524d551-7fad-4f39-b1a7-cc01f9083696',
  'b5cc06be-4ec8-4e87-8fca-1f628721d2f4',
  'bd2faf43-efbf-4c2e-a567-276a34cc9160',
  'b0e91722-aff4-4574-879e-8624925cf35a',
  'f93a2ca3-a2b4-415c-b763-c0820bc62252',
];

async function main() {
  // ── 1. Verify each row exists and matches Hormuz/Kharg→WTI before updating ──
  console.log('\n=== 1. Pre-update verification ===');
  const { data: rows, error: verifyErr } = await (sb as any)
    .from('correlated_market_pairs')
    .select('id, market_a_slug, market_b_slug, relationship, active')
    .in('id', OIL_IDS);

  if (verifyErr) { console.error('Verify ERR:', verifyErr.message); process.exit(1); }

  const found = rows as any[];
  console.log(`Found ${found.length} / ${OIL_IDS.length} rows`);

  const badRows: string[] = [];
  for (const row of found) {
    const isOilPair =
      (row.market_a_slug.includes('hormuz') || row.market_a_slug.includes('kharg') ||
       row.market_b_slug.includes('hormuz') || row.market_b_slug.includes('kharg')) &&
      (row.market_a_slug.includes('wti') || row.market_b_slug.includes('wti'));
    const status = isOilPair ? '✓ Hormuz/Kharg→WTI' : '✗ UNEXPECTED CONTENT';
    console.log(`  ${row.id.slice(0,8)} | ${row.market_a_slug} → ${row.market_b_slug} | active=${row.active} | ${status}`);
    if (!isOilPair) badRows.push(row.id);
  }

  if (found.length !== OIL_IDS.length) {
    const foundIds = new Set(found.map((r: any) => r.id));
    for (const id of OIL_IDS) {
      if (!foundIds.has(id)) console.log(`  MISSING: ${id}`);
    }
  }

  if (badRows.length > 0) {
    console.error(`\nAborted — ${badRows.length} row(s) don't match Hormuz/Kharg→WTI pattern. No updates made.`);
    process.exit(1);
  }

  // ── 2. Deactivate all 8 ───────────────────────────────────────────────────
  console.log('\n=== 2. Deactivating 8 oil pairs ===');
  const { data: upd, error: updErr } = await (sb as any)
    .from('correlated_market_pairs')
    .update({ active: false })
    .in('id', OIL_IDS)
    .select('id, market_a_slug, market_b_slug, active');
  if (updErr) { console.error('Update ERR:', updErr.message); process.exit(1); }
  for (const r of upd as any[]) {
    console.log(`  ${r.id.slice(0,8)} | active=${r.active} | ${r.market_a_slug} → ${r.market_b_slug}`);
  }

  // ── 3. Find matching approved suggestions and reject them ─────────────────
  console.log('\n=== 3. Rejecting corresponding approved suggestions ===');
  // Match on condition_id pairs — fetch them from the pairs we just deactivated
  const { data: pairDetails } = await (sb as any)
    .from('correlated_market_pairs')
    .select('market_a_condition_id, market_b_condition_id, market_a_slug, market_b_slug')
    .in('id', OIL_IDS);

  let rejectedCount = 0;
  for (const pair of pairDetails as any[]) {
    const { data: sugg, error: sErr } = await (sb as any)
      .from('correlated_pair_suggestions')
      .select('id, status')
      .eq('market_a_condition_id', pair.market_a_condition_id)
      .eq('market_b_condition_id', pair.market_b_condition_id)
      .in('status', ['approved', 'pending']);
    if (sErr) { console.log(`  ERR (${pair.market_a_slug}): ${sErr.message}`); continue; }
    if (!sugg || (sugg as any[]).length === 0) {
      console.log(`  (no active suggestion) ${pair.market_a_slug} → ${pair.market_b_slug}`);
      continue;
    }
    for (const s of sugg as any[]) {
      const { error: rErr } = await (sb as any)
        .from('correlated_pair_suggestions')
        .update({ status: 'rejected' })
        .eq('id', s.id);
      console.log(`  ${s.id.slice(0,8)} was ${s.status} → ${rErr ? 'ERR: ' + rErr.message : 'rejected ✓'} | ${pair.market_a_slug}`);
      if (!rErr) rejectedCount++;
    }
  }
  console.log(`  Total suggestions rejected: ${rejectedCount}`);

  // ── 4. c6ac5264 full record ───────────────────────────────────────────────
  console.log('\n=== 4. c6ac5264 Russia/Havrylivka → NATO full record ===');
  const { data: nato, error: natoErr } = await (sb as any)
    .from('correlated_market_pairs')
    .select('*')
    .eq('id', 'c6ac5264-77e5-4aca-ab4d-f0b905341a0d');
  console.log(natoErr ? `ERR: ${natoErr.message}` : JSON.stringify(nato, null, 2));

  // ── 5. Final active count ─────────────────────────────────────────────────
  console.log('\n=== 5. Final active pair count ===');
  const { count, error: cErr } = await (sb as any)
    .from('correlated_market_pairs')
    .select('*', { count: 'exact', head: true })
    .eq('active', true);
  console.log(cErr ? `ERR: ${cErr.message}` : `Active pairs remaining: ${count}`);

  const { data: activePairs } = await (sb as any)
    .from('correlated_market_pairs')
    .select('id, market_a_slug, market_b_slug, relationship')
    .eq('active', true)
    .order('created_at');
  for (const r of activePairs as any[]) {
    console.log(`  ${r.id.slice(0,8)} | ${r.relationship} | ${r.market_a_slug} → ${r.market_b_slug}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
