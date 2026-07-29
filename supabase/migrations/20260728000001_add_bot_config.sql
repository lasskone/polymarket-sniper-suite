-- bot_config: key-value store for per-module runtime configuration.
-- Allows toggling modules and changing intervals without a redeploy.
--
-- Schema:
--   module  — which bot module owns this setting (e.g. 'pair-discovery')
--   key     — setting name (e.g. 'enabled', 'interval_hours')
--   value   — text representation of the value ('true'/'false', '6', etc.)
--
-- The (module, key) pair is unique so upserts work cleanly.

CREATE TABLE IF NOT EXISTS bot_config (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  module     text        NOT NULL,
  key        text        NOT NULL,
  value      text        NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (module, key)
);

-- Seed pair-discovery defaults so the dashboard always has something to display.
INSERT INTO bot_config (module, key, value)
VALUES
  ('pair-discovery', 'enabled',        'false'),
  ('pair-discovery', 'interval_hours', '6')
ON CONFLICT (module, key) DO NOTHING;
