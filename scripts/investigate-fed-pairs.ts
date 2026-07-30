#!/usr/bin/env npx tsx
/**
 * Investigate: why does isValidMarket() reject the Fed-rate pairs?
 *
 * Approach: raw fetch against Gamma API to avoid GammaApiClient constructor deps.
 * Compares DB-stored conditionId vs what the API actually returns for that query.
 */
import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

async function gammaByConditionId(conditionId: string): Promise<Record<string, unknown> | null> {
  const url = `${GAMMA_BASE}/markets?condition_id=${conditionId}&limit=1`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return null;
  const data = await r.json() as unknown[];
  return (Array.isArray(data) && data.length > 0) ? data[0] as Record<string, unknown> : null;
}

async function gammaBySlug(slug: string): Promise<Record<string, unknown> | null> {
  const url = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}&limit=1`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return null;
  const data = await r.json() as unknown[];
  return (Array.isArray(data) && data.length > 0) ? data[0] as Record<string, unknown> : null;
}

async function main() {
  const db = getSupabaseClient();

  // Fetch all Fed-rate pairs (active or not — the bot may have already deactivated them)
  const { data: pairs, error } = await (db as any)
    .from('correlated_market_pairs')
    .select('id, market_a_slug, market_b_slug, market_a_condition_id, market_b_condition_id, active')
    .ilike('market_a_slug', '%fed%')
    .limit(5);

  if (error || !pairs?.length) {
    console.error('DB error or no rows:', error?.message ?? 'empty');
    return;
  }

  console.log(`Found ${pairs.length} Fed-rate pair(s) (active or not)\n`);

  // Deep-investigate the first one
  const pair = pairs[0] as {
    id: string;
    market_a_slug: string;
    market_b_slug: string;
    market_a_condition_id: string;
    market_b_condition_id: string;
    active: boolean;
  };

  console.log('━━━ Pair from DB ━━━');
  console.log(`  market_a_slug:          ${pair.market_a_slug}`);
  console.log(`  market_b_slug:          ${pair.market_b_slug}`);
  console.log(`  active:                 ${pair.active}`);
  console.log(`  market_a_condition_id:  "${pair.market_a_condition_id}"`);
  console.log(`  market_b_condition_id:  "${pair.market_b_condition_id}"`);
  console.log();

  // ── Market A: lookup by conditionId ──────────────────────────────────────
  console.log(`━━━ Gamma lookup by conditionId (market_a) ━━━`);
  console.log(`  URL: ${GAMMA_BASE}/markets?condition_id=${pair.market_a_condition_id}&limit=1`);
  const byCondA = await gammaByConditionId(pair.market_a_condition_id);
  if (!byCondA) {
    console.log('  Result: null / empty array');
  } else {
    const returnedCondId = String(byCondA['conditionId'] ?? '');
    const returnedClosed = byCondA['closed'];
    const returnedSlug   = byCondA['slug'] ?? 'N/A';
    const returnedQ      = byCondA['question'] ?? 'N/A';
    console.log(`  returned.conditionId:  "${returnedCondId}"`);
    console.log(`  returned.closed:       ${returnedClosed}`);
    console.log(`  returned.slug:         ${returnedSlug}`);
    console.log(`  returned.question:     ${returnedQ}`);
    console.log();

    // The exact comparison in isValidMarket() line 126:
    const match = returnedCondId === pair.market_a_condition_id;
    console.log(`  isValidMarket() line 126:`);
    console.log(`    market.conditionId !== expectedConditionId`);
    console.log(`    "${returnedCondId}"`);
    console.log(`    !== "${pair.market_a_condition_id}"`);
    console.log(`    → mismatch=${!match}  (true means REJECTED by isValidMarket)`);

    if (!match) {
      const db_ = pair.market_a_condition_id;
      const api = returnedCondId;
      console.log(`\n  Char-by-char diff:`);
      if (db_.length !== api.length) {
        console.log(`    Length: DB=${db_.length}  API=${api.length}`);
      }
      let diffCount = 0;
      for (let i = 0; i < Math.max(db_.length, api.length); i++) {
        if (db_[i] !== api[i]) {
          console.log(`    pos[${i}]: DB='${db_[i] ?? '<missing>'}' (0x${db_.charCodeAt(i).toString(16)})  API='${api[i] ?? '<missing>'}' (0x${api.charCodeAt(i).toString(16)})`);
          if (++diffCount >= 5) { console.log('    ... (first 5 diffs shown)'); break; }
        }
      }
    }
  }
  console.log();

  // ── Market A: lookup by slug ──────────────────────────────────────────────
  console.log(`━━━ Gamma lookup by slug (market_a) ━━━`);
  console.log(`  URL: ${GAMMA_BASE}/markets?slug=${encodeURIComponent(pair.market_a_slug)}&limit=1`);
  const bySlugA = await gammaBySlug(pair.market_a_slug);
  if (!bySlugA) {
    console.log('  Result: null / empty');
  } else {
    console.log(`  returned.conditionId:  "${bySlugA['conditionId'] ?? 'N/A'}"`);
    console.log(`  returned.closed:       ${bySlugA['closed']}`);
    console.log(`  returned.slug:         ${bySlugA['slug'] ?? 'N/A'}`);
    const slugMatch = String(bySlugA['conditionId'] ?? '') === pair.market_a_condition_id;
    console.log(`  slug→conditionId matches DB?  ${slugMatch}`);
  }
  console.log();

  // ── Market B ──────────────────────────────────────────────────────────────
  console.log(`━━━ Gamma lookup by conditionId (market_b) ━━━`);
  const byCondB = await gammaByConditionId(pair.market_b_condition_id);
  if (!byCondB) {
    console.log('  Result: null / empty');
  } else {
    const returnedCondIdB = String(byCondB['conditionId'] ?? '');
    const matchB = returnedCondIdB === pair.market_b_condition_id;
    console.log(`  returned.conditionId:  "${returnedCondIdB}"`);
    console.log(`  returned.closed:       ${byCondB['closed']}`);
    console.log(`  returned.slug:         ${byCondB['slug'] ?? 'N/A'}`);
    console.log(`  conditionId matches DB?  ${matchB}  (false = REJECTED)`);
  }
  console.log();

  // ── Summary across all 5 pairs ────────────────────────────────────────────
  console.log('━━━ Summary: all Fed-rate pairs ━━━');
  for (const p of pairs as typeof pair[]) {
    const mA = await gammaByConditionId(p.market_a_condition_id);
    const mB = await gammaByConditionId(p.market_b_condition_id);
    const aId = mA ? String(mA['conditionId'] ?? '') : null;
    const bId = mB ? String(mB['conditionId'] ?? '') : null;
    const aMatch = aId === p.market_a_condition_id;
    const bMatch = bId === p.market_b_condition_id;
    const aClosed = mA?.['closed'];
    const bClosed = mB?.['closed'];
    const reason = !mA ? 'A=null' : !aMatch ? 'A=condId-mismatch' : aClosed ? 'A=closed' :
                   !mB ? 'B=null' : !bMatch ? 'B=condId-mismatch' : bClosed ? 'B=closed' : 'VALID';
    console.log(`  ${p.market_a_slug.slice(0, 55).padEnd(55)} → ${reason}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
