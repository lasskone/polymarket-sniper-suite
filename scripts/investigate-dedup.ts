import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL             = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main(): Promise<void> {
  // ── row counts ─────────────────────────────────────────────────────────────
  const { count: total }       = await (supabase as any).from('paper_trades').select('*', { count: 'exact', head: true });
  const { count: cleanCount }  = await (supabase as any).from('paper_trades').select('*', { count: 'exact', head: true }).eq('suspect_duplicate', false);
  const { count: suspectCount } = await (supabase as any).from('paper_trades').select('*', { count: 'exact', head: true }).eq('suspect_duplicate', true);
  console.log(`Total rows           : ${total}`);
  console.log(`suspect_duplicate=false: ${cleanCount}`);
  console.log(`suspect_duplicate=true : ${suspectCount}`);

  // ── check known duplicate ──────────────────────────────────────────────────
  const { data: known } = await (supabase as any)
    .from('paper_trades')
    .select('id, module, market_label, opened_at, opened_minute, suspect_duplicate')
    .ilike('market_label', '%fra-esp%')
    .order('opened_at');
  console.log(`\n"fifwc-fra-esp" rows:`);
  if (!known?.length) {
    console.log('  (none found)');
  } else {
    for (const r of known) {
      console.log(`  id=${r.id.slice(0,8)}  label="${r.market_label}"  opened=${r.opened_at}  min=${r.opened_minute}  suspect=${r.suspect_duplicate}`);
    }
  }

  // ── paginated duplicate scan ───────────────────────────────────────────────
  console.log('\nPaginated clean-row duplicate scan …');
  const PAGE = 1000;
  const allClean: Array<{ id: string; module: string; market_label: string; opened_at: string; opened_minute: string }> = [];
  let offset = 0;
  while (true) {
    const { data: rows, error } = await (supabase as any)
      .from('paper_trades')
      .select('id, module, market_label, opened_at, opened_minute')
      .eq('suspect_duplicate', false)
      .order('opened_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) { console.error('page error:', error.message); break; }
    if (!rows?.length) break;
    allClean.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`Total clean rows fetched (all pages): ${allClean.length}`);

  const groups = new Map<string, typeof allClean>();
  for (const r of allClean) {
    const key = `${r.module}\0${r.market_label}\0${r.opened_minute}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`Duplicate groups in clean cohort: ${dupGroups.length}`);
  for (const g of dupGroups) {
    const r0 = g[0];
    console.log(`  module="${r0.module}"  label="${r0.market_label}"  minute=${r0.opened_minute}  count=${g.length}`);
    g.forEach((r, i) => console.log(`    [${i === 0 ? 'KEEP' : 'MARK'}] id=${r.id}  opened=${r.opened_at}`));
  }

  if (dupGroups.length > 0) {
    const toMark = dupGroups.flatMap(g => g.slice(1).map(r => r.id));
    console.log(`\nMarking ${toMark.length} row(s) suspect_duplicate = true …`);
    const { error: upErr } = await (supabase as any)
      .from('paper_trades').update({ suspect_duplicate: true }).in('id', toMark);
    console.log(upErr ? `Update FAILED: ${upErr.message}` : 'Update OK.');
  }

  // ── confirm upsert error ────────────────────────────────────────────────────
  console.log('\nConfirm upsert error (no index = error):');
  const probe = `__probe_${Date.now()}`;
  const { error: uErr } = await (supabase as any)
    .from('paper_trades')
    .upsert(
      { module: 'logic-arb', market_label: probe, net_profit_usd: 0, shares: 1, trading_mode: 'paper' },
      { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true },
    );
  await (supabase as any).from('paper_trades').delete().eq('market_label', probe);
  console.log(uErr
    ? `upsert error: "${uErr.message}" → index MISSING, every onConflict insert is FAILING`
    : 'upsert OK — index exists or fallback to pk was used');
}

main().catch(err => { console.error(err); process.exit(1); });
