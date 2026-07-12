/**
 * Supabase client singleton for the sniper suite.
 * Requires @supabase/supabase-js — install with:
 *   npm install @supabase/supabase-js
 */

// Lazy import so the suite still boots without Supabase configured.
let _client: unknown = null;

export async function getSupabaseClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set.',
    );
  }

  // Dynamic import avoids a hard dep at boot time.
  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(url, key);
  return _client;
}
