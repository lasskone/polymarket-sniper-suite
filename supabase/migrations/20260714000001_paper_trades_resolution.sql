-- Extend paper_trades to support open/pending sportsbook-arb positions
-- that only resolve when the real-world match settles.
--
-- Existing rows (dip-arb, negrisk-arb, logic-arb) keep status='settled' via
-- the column default — their net_profit_usd is already final, no backfill needed.

-- Drop the NOT NULL constraint on net_profit_usd: open sportsbook-arb rows
-- set it to NULL at insert time and the resolver fills it in on settlement.
alter table paper_trades alter column net_profit_usd drop not null;

alter table paper_trades
  add column if not exists status       text        not null default 'settled'
    check (status in ('settled', 'open', 'won', 'lost')),
  add column if not exists condition_id text,
  add column if not exists token_id     text,
  add column if not exists entry_price  numeric,
  add column if not exists resolved_at  timestamptz;

-- Partial index — only open rows need fast lookup by the resolver.
create index if not exists idx_paper_trades_open_sportsbook
  on paper_trades (module, status)
  where status = 'open';
