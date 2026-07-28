#!/usr/bin/env npx tsx
import 'dotenv/config';
import { getSupabaseClient } from '../modules/shared/supabase-client.js';

async function main() {
  const db = getSupabaseClient();
  const { count: nonSuspect } = await (db as any).from('paper_trades').select('*', { count: 'exact', head: true }).eq('suspect_duplicate', false);
  const { count: total } = await (db as any).from('paper_trades').select('*', { count: 'exact', head: true });
  const { count: suspect } = await (db as any).from('paper_trades').select('*', { count: 'exact', head: true }).eq('suspect_duplicate', true);
  console.log(`Total: ${total}  |  Non-suspect: ${nonSuspect}  |  Suspect: ${suspect}`);
}

main();
