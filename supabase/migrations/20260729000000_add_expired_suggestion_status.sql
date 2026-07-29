-- Allow suggestions to be marked 'expired' when both markets are verified
-- closed/delisted via the Gamma API slug check. This keeps expired suggestions
-- in the DB (not deleted) but hides them from the default pending review queue.

-- 1. Drop the existing status check constraint by name.
ALTER TABLE correlated_pair_suggestions
  DROP CONSTRAINT IF EXISTS correlated_pair_suggestions_status_check;

-- 2. Add an updated check constraint that includes 'expired'.
ALTER TABLE correlated_pair_suggestions
  ADD CONSTRAINT correlated_pair_suggestions_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));

-- 3. Add a partial index for fast expired-suggestion queries.
CREATE INDEX IF NOT EXISTS correlated_pair_suggestions_expired_idx
  ON correlated_pair_suggestions (status)
  WHERE status = 'expired';
