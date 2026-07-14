-- Correlated pair suggestions: AI-generated candidates awaiting human approval.
--
-- Populated by:   scripts/suggest-correlated-pairs.ts  (one-off, manual run)
-- Reviewed by:    scripts/review-pair-suggestions.ts   (read-only listing)
-- Approved via:   scripts/approve-pair-suggestion.ts <id>  OR manual SQL
--
-- NEVER insert directly into correlated_market_pairs without explicit approval.

CREATE TABLE correlated_pair_suggestions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  market_a_condition_id   text        NOT NULL,
  market_b_condition_id   text        NOT NULL,
  market_a_slug           text        NOT NULL,
  market_b_slug           text        NOT NULL,
  market_a_question       text        NOT NULL,
  market_b_question       text        NOT NULL,
  relationship            text        NOT NULL
    CHECK (relationship IN ('a_implies_b', 'mutually_exclusive')),
  confidence              numeric     NOT NULL,
  reasoning               text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at              timestamptz NOT NULL DEFAULT now(),

  -- Prevent duplicate suggestions on re-runs (either direction of the pair).
  -- The suggest script always inserts with A < B lexicographically, so a
  -- single unique constraint on (A, B) is sufficient when paired with the
  -- existing-pairs pre-filter in the script.
  CONSTRAINT correlated_pair_suggestions_unique_pair
    UNIQUE (market_a_condition_id, market_b_condition_id)
);

-- Fast lookup of pending suggestions for the review script.
CREATE INDEX correlated_pair_suggestions_status_idx
  ON correlated_pair_suggestions (status)
  WHERE status = 'pending';
