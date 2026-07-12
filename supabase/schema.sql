-- =============================================================================
-- Polymarket Sniper Suite — Supabase Schema
-- =============================================================================
-- Apply via: Supabase Dashboard → SQL Editor → paste → Run
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- TABLE: trades
-- Records every order placed by any module.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  module            text          NOT NULL,              -- 'latency-sniper' | 'resolution-arb' | 'cross-market-arb' | 'market-making'
  market_id         text          NOT NULL,              -- Polymarket condition/market ID
  market_slug       text,                               -- human-readable slug
  side              text          NOT NULL,              -- 'BUY' | 'SELL'
  price             numeric(10,4) NOT NULL,
  size              numeric(20,8) NOT NULL,              -- token quantity
  amount_usdc       numeric(20,4) NOT NULL,              -- price × size
  order_id          text,                               -- Polymarket CLOB order ID
  status            text          NOT NULL DEFAULT 'pending', -- 'pending' | 'filled' | 'cancelled' | 'failed'
  expected_profit   numeric(10,4),                      -- estimated at order time
  realized_profit   numeric(20,4),                      -- filled in after market resolves
  metadata          jsonb,                              -- event type, match info, leg details, etc.
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  executed_at       timestamptz,                        -- timestamp of actual fill

  CONSTRAINT trades_side_check   CHECK (side   IN ('BUY', 'SELL')),
  CONSTRAINT trades_status_check CHECK (status IN ('pending', 'filled', 'cancelled', 'failed')),
  CONSTRAINT trades_price_positive CHECK (price > 0),
  CONSTRAINT trades_size_positive  CHECK (size  > 0)
);

-- ---------------------------------------------------------------------------
-- TABLE: opportunities
-- Every edge detected, regardless of whether we traded on it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  module            text          NOT NULL,
  market_id         text          NOT NULL,
  market_slug       text,
  opportunity_type  text          NOT NULL,  -- 'goal' | 'red_card' | 'penalty' | 'resolution_delay' | 'cross_market_spread'
  current_price     numeric(10,4) NOT NULL,  -- market price at detection time
  expected_price    numeric(10,4) NOT NULL,  -- our fair-value estimate
  edge              numeric(10,4) NOT NULL,  -- expected_price - current_price
  confidence        numeric(5,2),            -- 0–100
  status            text          NOT NULL DEFAULT 'detected', -- 'detected' | 'traded' | 'expired' | 'missed'
  metadata          jsonb,                   -- match info, score, minute, spreads, etc.
  detected_at       timestamptz   NOT NULL DEFAULT now(),
  traded_at         timestamptz,             -- set when status → 'traded'
  expires_at        timestamptz,             -- TTL for this opportunity

  CONSTRAINT opp_status_check CHECK (status IN ('detected', 'traded', 'expired', 'missed')),
  CONSTRAINT opp_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);

-- ---------------------------------------------------------------------------
-- TABLE: performance
-- Daily aggregate stats per module (one row per module per date).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS performance (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  date                  date          NOT NULL,
  module                text          NOT NULL,
  total_trades          integer       NOT NULL DEFAULT 0,
  winning_trades        integer       NOT NULL DEFAULT 0,
  losing_trades         integer       NOT NULL DEFAULT 0,
  total_profit_usdc     numeric(20,4) NOT NULL DEFAULT 0,
  total_volume_usdc     numeric(20,4) NOT NULL DEFAULT 0,
  avg_profit_per_trade  numeric(20,4) NOT NULL DEFAULT 0,
  win_rate              numeric(5,2)  NOT NULL DEFAULT 0,  -- percentage
  max_drawdown_usdc     numeric(20,4) NOT NULL DEFAULT 0,
  sharpe_ratio          numeric(10,4) NOT NULL DEFAULT 0,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT performance_unique_module_date UNIQUE (module, date),
  CONSTRAINT performance_win_rate_range CHECK (win_rate >= 0 AND win_rate <= 100)
);

-- ---------------------------------------------------------------------------
-- TABLE: risk_management
-- Daily risk state — one row per date (cross-module aggregate).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_management (
  id                         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  date                       date          NOT NULL UNIQUE,
  daily_pnl_usdc             numeric(20,4) NOT NULL DEFAULT 0,
  daily_trades               integer       NOT NULL DEFAULT 0,
  daily_volume_usdc          numeric(20,4) NOT NULL DEFAULT 0,
  current_exposure_usdc      numeric(20,4) NOT NULL DEFAULT 0,
  circuit_breaker_triggered  boolean       NOT NULL DEFAULT false,
  circuit_breaker_reason     text,
  last_trade_at              timestamptz,
  created_at                 timestamptz   NOT NULL DEFAULT now(),
  updated_at                 timestamptz   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- TABLE: market_snapshots
-- Point-in-time price/liquidity captures for market monitoring.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_snapshots (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    text          NOT NULL,
  market_slug  text,
  yes_price    numeric(10,4),
  no_price     numeric(10,4),
  volume_24h   numeric(20,4),
  liquidity    numeric(20,4),
  spread       numeric(10,4),
  captured_at  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT snapshot_yes_price_range CHECK (yes_price IS NULL OR (yes_price >= 0 AND yes_price <= 1)),
  CONSTRAINT snapshot_no_price_range  CHECK (no_price  IS NULL OR (no_price  >= 0 AND no_price  <= 1))
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

-- trades
CREATE INDEX IF NOT EXISTS idx_trades_module_created
  ON trades (module, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_market_created
  ON trades (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_status
  ON trades (status);

-- opportunities
CREATE INDEX IF NOT EXISTS idx_opp_module_status_detected
  ON opportunities (module, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_opp_market_detected
  ON opportunities (market_id, detected_at DESC);

-- performance
CREATE INDEX IF NOT EXISTS idx_perf_module_date
  ON performance (module, date DESC);

-- risk_management
CREATE INDEX IF NOT EXISTS idx_risk_date
  ON risk_management (date DESC);

-- market_snapshots
CREATE INDEX IF NOT EXISTS idx_snapshots_market_captured
  ON market_snapshots (market_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- AUTO-UPDATE updated_at TRIGGER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to every table that has updated_at
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trades', 'performance', 'risk_management'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s;
       CREATE TRIGGER trg_%1$s_updated_at
         BEFORE UPDATE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
-- All modules use the service role key which bypasses RLS by default.
-- RLS is enabled so the schema is ready for multi-tenant use; the
-- permissive policy below grants full access to authenticated users.

ALTER TABLE trades            ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities     ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_management   ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_snapshots  ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users
-- (bot connects via service role, which bypasses RLS entirely)
DROP POLICY IF EXISTS "authenticated_full_access_trades" ON trades;
CREATE POLICY "authenticated_full_access_trades"
  ON trades FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_full_access_opportunities" ON opportunities;
CREATE POLICY "authenticated_full_access_opportunities"
  ON opportunities FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_full_access_performance" ON performance;
CREATE POLICY "authenticated_full_access_performance"
  ON performance FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_full_access_risk_management" ON risk_management;
CREATE POLICY "authenticated_full_access_risk_management"
  ON risk_management FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_full_access_market_snapshots" ON market_snapshots;
CREATE POLICY "authenticated_full_access_market_snapshots"
  ON market_snapshots FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- VERIFICATION QUERY
-- Run this after applying schema to confirm all tables exist:
--
--   SELECT table_name
--   FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN (
--       'trades','opportunities','performance',
--       'risk_management','market_snapshots'
--     )
--   ORDER BY table_name;
--
-- Expected: 5 rows.
-- ---------------------------------------------------------------------------
