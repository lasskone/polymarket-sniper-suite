-- Add live_eligible to correlated_market_pairs (default true — all existing pairs can trade live)
ALTER TABLE correlated_market_pairs
  ADD COLUMN IF NOT EXISTS live_eligible boolean NOT NULL DEFAULT true;

-- Seed bot_config for logic-arb live trading controls
INSERT INTO bot_config (module, key, value)
VALUES
  ('logic-arb', 'live_enabled',     'false'),
  ('logic-arb', 'position_size_pct', '2')
ON CONFLICT (module, key) DO NOTHING;
