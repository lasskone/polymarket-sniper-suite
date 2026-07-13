/**
 * One-shot migration runner — applies correlated_market_pairs DDL to Supabase.
 * Run via: railway run node scripts/apply-migration.mjs
 *
 * Uses the Supabase Management API (api.supabase.com/v1) which accepts the
 * service_role key for project-scoped database queries.
 */

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

// Extract project ref from URL: https://{ref}.supabase.co
const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
console.log(`Project ref: ${ref}`);

const migrationSql = `
CREATE TABLE IF NOT EXISTS correlated_market_pairs (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  market_a_condition_id    text          NOT NULL,
  market_b_condition_id    text          NOT NULL,
  market_a_slug            text          NOT NULL,
  market_b_slug            text          NOT NULL,
  relationship             text          NOT NULL,
  notes                    text,
  active                   boolean       NOT NULL DEFAULT true,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT correlated_pairs_relationship_check
    CHECK (relationship IN ('a_implies_b', 'mutually_exclusive')),
  CONSTRAINT correlated_pairs_unique_ab
    UNIQUE (market_a_condition_id, market_b_condition_id)
);

CREATE INDEX IF NOT EXISTS idx_corr_pairs_active
  ON correlated_market_pairs (active) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_corr_pairs_market_a
  ON correlated_market_pairs (market_a_condition_id);

CREATE INDEX IF NOT EXISTS idx_corr_pairs_market_b
  ON correlated_market_pairs (market_b_condition_id);

ALTER TABLE correlated_market_pairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_full_access_correlated_market_pairs"
  ON correlated_market_pairs;

CREATE POLICY "authenticated_full_access_correlated_market_pairs"
  ON correlated_market_pairs FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
`;

// Supabase Management API: POST /v1/projects/{ref}/database/query
// This endpoint accepts a personal access token OR (on some plans) the service_role_key.
const mgmtUrl = `https://api.supabase.com/v1/projects/${ref}/database/query`;
console.log(`Calling: POST ${mgmtUrl}`);

const res = await fetch(mgmtUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: migrationSql }),
});

const body = await res.text();
console.log(`Response status: ${res.status}`);
console.log(`Response body: ${body}`);

if (!res.ok) {
  // Management API rejected the service_role_key — requires a personal access token.
  // Fallback: try to SELECT from the table to check its current state,
  // then print the SQL for manual execution in the Supabase Dashboard.
  console.log('\n--- Fallback: checking table existence via PostgREST ---');

  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/correlated_market_pairs?select=count&limit=0`,
    {
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'apikey': SERVICE_ROLE_KEY,
        'Prefer': 'count=exact',
      },
    }
  );

  if (checkRes.ok) {
    const count = checkRes.headers.get('content-range') ?? 'unknown';
    console.log(`Table already exists! Row count: ${count}`);
    process.exit(0);
  }

  const checkBody = await checkRes.json().catch(() => ({}));
  console.log(`PostgREST check status: ${checkRes.status}`);
  console.log(`PostgREST check body:`, JSON.stringify(checkBody));

  if (checkBody?.code === 'PGRST205' || checkBody?.message?.includes('schema cache')) {
    console.log('\nTable does not exist. Apply migration manually:');
    console.log('1. Open https://supabase.com/dashboard/project/' + ref + '/sql');
    console.log('2. Paste and run the SQL in supabase/migrations/20260713000000_add_correlated_market_pairs.sql');
    process.exit(1);
  }

  console.log('\nUnexpected response — check status above.');
  process.exit(1);
}

console.log('\nMigration applied via Management API.');

// Verify
console.log('\n--- Verification: SELECT COUNT(*) ---');
const verifyRes = await fetch(
  `${SUPABASE_URL}/rest/v1/correlated_market_pairs?select=count&limit=0`,
  {
    headers: {
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'apikey': SERVICE_ROLE_KEY,
      'Prefer': 'count=exact',
    },
  }
);

if (verifyRes.ok) {
  const range = verifyRes.headers.get('content-range') ?? '0/?';
  console.log(`Table exists. content-range: ${range} (rows = ${range.split('/')[1] ?? '0'})`);
} else {
  console.log(`Verification failed: ${verifyRes.status}`);
}
