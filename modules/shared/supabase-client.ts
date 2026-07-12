import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

// ---------------------------------------------------------------------------
// Singleton — one client per process, initialised on first call.
// ---------------------------------------------------------------------------
let _client: SupabaseClient<Database> | null = null;

/**
 * Returns the shared Supabase client, initialised with the service role key.
 *
 * Requires env vars:
 *   SUPABASE_URL              — project URL (https://<ref>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — server-side secret (bypasses RLS)
 *   SUPABASE_ANON_KEY         — fallback if service role key is absent
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('[Supabase] SUPABASE_URL is not set.');
  }
  if (!key) {
    throw new Error(
      '[Supabase] SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) is not set.',
    );
  }

  _client = createClient<Database>(url, key, {
    auth: {
      // Bot runs server-side only — disable session persistence.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

/**
 * Verifies the Supabase connection by running a lightweight query against
 * the trades table. Throws if the connection or credentials are invalid.
 */
export async function verifySupabaseConnection(): Promise<void> {
  const client = getSupabaseClient();

  const { error } = await client
    .from('trades')
    .select('id')
    .limit(1);

  if (error) {
    throw new Error(`[Supabase] Connection verification failed: ${error.message}`);
  }
}
