-- =============================================================================
-- Migration: add_correlated_market_pairs
-- Created:   2026-07-13
--
-- Stores human-curated pairs of logically-related Polymarket markets that the
-- logic-arb module monitors for mispricing opportunities.
--
-- Two relationship types:
--   'a_implies_b'       — if A resolves YES, B MUST also resolve YES.
--                         Invariant: price(B) >= price(A).
--                         Violation → buy YES-B + buy NO-A.
--
--   'mutually_exclusive' — A and B cannot both resolve YES.
--                          Invariant: price(A) + price(B) <= 1.
--                          Violation → buy NO-A + buy NO-B.
--
-- The logic-arb module reads active=true rows on every scan cycle.
-- Disable a pair without deleting it by setting active=false.
-- =============================================================================

CREATE TABLE IF NOT EXISTS correlated_market_pairs (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CLOB condition IDs used for price lookups + fee resolution
  market_a_condition_id    text          NOT NULL,
  market_b_condition_id    text          NOT NULL,

  -- Human-readable slugs (from Gamma API / Polymarket URL)
  market_a_slug            text          NOT NULL,
  market_b_slug            text          NOT NULL,

  -- Logical relationship between the two markets
  relationship             text          NOT NULL,

  -- Free-text notes (e.g. "Same underlying event, different resolution windows")
  notes                    text,

  -- When false the row is ignored by the scanner (soft-delete alternative)
  active                   boolean       NOT NULL DEFAULT true,

  created_at               timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT correlated_pairs_relationship_check
    CHECK (relationship IN ('a_implies_b', 'mutually_exclusive')),

  -- Prevent exact duplicate pairs in the same direction
  CONSTRAINT correlated_pairs_unique_ab
    UNIQUE (market_a_condition_id, market_b_condition_id)
);

-- Speed up the active-pairs query issued on every scan cycle
CREATE INDEX IF NOT EXISTS idx_corr_pairs_active
  ON correlated_market_pairs (active)
  WHERE active = true;

-- Look up pairs by either market's condition ID
CREATE INDEX IF NOT EXISTS idx_corr_pairs_market_a
  ON correlated_market_pairs (market_a_condition_id);

CREATE INDEX IF NOT EXISTS idx_corr_pairs_market_b
  ON correlated_market_pairs (market_b_condition_id);

-- ---------------------------------------------------------------------------
-- RLS (matches the pattern used in schema.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE correlated_market_pairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_full_access_correlated_market_pairs"
  ON correlated_market_pairs;

CREATE POLICY "authenticated_full_access_correlated_market_pairs"
  ON correlated_market_pairs FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
