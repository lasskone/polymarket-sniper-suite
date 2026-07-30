-- Replace the failed full unique index with a partial unique index scoped
-- to suspect_duplicate = false.
--
-- History:
--   20260728000000_paper_trades_dedup.sql attempted:
--     CREATE UNIQUE INDEX idx_paper_trades_dedup ON paper_trades (module, market_label, opened_minute);
--   This failed with 23505 because suspect_duplicate rows (marked by mark-suspect-trades.ts)
--   contained duplicate (module, market_label, opened_minute) tuples — the script ran AFTER
--   the flag column existed but BEFORE all dupes were marked.  The index was never retried.
--
-- Fix:
--   A partial index scoped to WHERE suspect_duplicate = false:
--   • Excludes all historical suspect rows → creation succeeds unconditionally.
--   • New inserts always have suspect_duplicate = false (the column default) so they fall
--     inside the partial index and ON CONFLICT (module, market_label, opened_minute) resolves
--     correctly via PostgreSQL partial-index inference.
--   • The existing bot/index.ts upsert calls require NO change:
--       .upsert({...}, { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true })
--     PostgreSQL infers the partial index when the inserted row satisfies the predicate
--     (suspect_duplicate = false) and there is exactly one matching unique index on those columns.
--
-- Pre-condition (enforced by scripts/investigate-dedup.ts, run 2026-07-30):
--   All (module, market_label, opened_minute) duplicate groups in the clean cohort
--   (suspect_duplicate = false) have been resolved — the last one was:
--     logic-arb / fifwc-fra-esp-...-3-2 / ... at 2026-07-24T12:34
--   Row d29b80b8 marked suspect_duplicate = true.  Zero remaining duplicates confirmed.

-- Drop the old (non-partial) index if it somehow exists from a partial earlier run.
drop index if exists idx_paper_trades_dedup;

-- Create the partial unique index.
create unique index idx_paper_trades_dedup
  on paper_trades (module, market_label, opened_minute)
  where suspect_duplicate = false;
