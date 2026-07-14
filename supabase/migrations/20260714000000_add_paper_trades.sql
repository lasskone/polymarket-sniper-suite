-- paper_trades: records every detected signal from the 3 risk-free arbitrage modules
-- as a simulated (paper) trade so we can track detection performance over time.
-- Both paper and live trading modes are recorded here, labeled via trading_mode.

create table if not exists paper_trades (
  id             uuid        primary key default gen_random_uuid(),
  module         text        not null check (module in ('dip-arb', 'negrisk-arb', 'logic-arb')),
  market_label   text        not null,
  net_profit_usd numeric     not null,
  shares         numeric     not null,
  opened_at      timestamptz not null default now(),
  metadata       jsonb,
  trading_mode   text        not null
);

create index if not exists idx_paper_trades_module    on paper_trades (module);
create index if not exists idx_paper_trades_opened_at on paper_trades (opened_at);
