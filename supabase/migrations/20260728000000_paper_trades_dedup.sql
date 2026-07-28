-- Add suspect_duplicate flag for inflated logic-arb paper trades from July 22-23,
-- plus a per-minute unique dedup guard for logic-arb and negrisk-arb.
--
-- WHY NOT expression-based partial unique indexes:
--   PostgREST's onConflict parameter only accepts plain column names.
--   A partial (WHERE ...) or expression (date_trunc(...)) index cannot be
--   targeted by ON CONFLICT (cols) DO NOTHING — PostgreSQL requires the
--   exact partial predicate to be repeated in the ON CONFLICT clause, which
--   PostgREST does not expose.  Without onConflict, Supabase upsert silently
--   defaults to the primary key (id), which is always unique → dedup is a no-op.
--
-- SOLUTION: Add an opened_minute generated stored column so that
--   ON CONFLICT (module, market_label, opened_minute)
-- targets a plain-column unique index that PostgREST CAN infer.

-- 1. Flag column — set by the one-off mark-suspect-trades script; excluded from
--    /api/paper-stats aggregate by default.
alter table paper_trades
  add column if not exists suspect_duplicate boolean not null default false;

create index if not exists idx_paper_trades_suspect
  on paper_trades (module, opened_at)
  where suspect_duplicate = true;

-- 2. Generated stored column: minute-level truncation of opened_at.
--    GENERATED ALWAYS means it is computed by the DB and cannot be manually set.
--    STORED means it is physically persisted and therefore indexable.
alter table paper_trades
  add column if not exists opened_minute timestamptz
  generated always as (date_trunc('minute', opened_at)) stored;

-- 3. Per-minute dedup constraint on (module, market_label, opened_minute).
--    All three columns are plain — PostgREST can target them via:
--      .upsert({...}, { onConflict: 'module,market_label,opened_minute', ignoreDuplicates: true })
--    This catches rapid-restart duplicates that slip past the in-memory cooldown Map.
--    Non-partial: applies to all modules.  DipArb uses `round ${roundId}` in the
--    label so each label is naturally unique; no false conflicts arise.
create unique index if not exists idx_paper_trades_dedup
  on paper_trades (module, market_label, opened_minute);
