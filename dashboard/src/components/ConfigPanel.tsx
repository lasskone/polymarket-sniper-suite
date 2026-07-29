import { useState } from 'react';
import type { BotConfig } from '../types';

interface ConfigPanelProps {
  config: BotConfig | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="s-stat-row py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="font-inter text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-jb text-[11px]" style={{ color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pair Discovery card — toggle + interval, writes to /api/config/pair-discovery
// ---------------------------------------------------------------------------

function PairDiscoveryCard({ config }: { config: BotConfig }) {
  const pd = config.pairDiscovery ?? { enabled: false, intervalHours: 6 };

  const [enabled, setEnabled]             = useState(pd.enabled);
  const [intervalHours, setIntervalHours] = useState(String(pd.intervalHours));
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [saved, setSaved]                 = useState(false);

  // Keep local state in sync when config prop updates from WS
  // (simple guard: only reset if different from what we have)
  const remoteEnabled = pd.enabled;
  const remoteInterval = String(pd.intervalHours);
  if (!saving && remoteEnabled !== enabled && remoteInterval === intervalHours) {
    setEnabled(remoteEnabled);
  }

  async function put(patch: { enabled?: boolean; interval_hours?: number }) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/config/pair-discovery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Unknown error');
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    put({ enabled: next });
  }

  function handleIntervalBlur() {
    const val = parseFloat(intervalHours);
    if (isNaN(val) || val <= 0) {
      setError('Interval must be a positive number');
      return;
    }
    setError(null);
    put({ interval_hours: val });
  }

  return (
    <div className="s-card">
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Pair Discovery
            </h2>
            <p className="font-inter text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              AI-powered correlated market pair scanning
            </p>
          </div>
          <span
            className="font-jb text-[9px] px-2 py-0.5 rounded-full"
            style={{
              background: enabled ? 'rgba(74,222,128,0.1)' : 'rgba(120,120,120,0.08)',
              border: `1px solid ${enabled ? 'rgba(74,222,128,0.25)' : 'rgba(120,120,120,0.2)'}`,
              color: enabled ? 'var(--profit)' : 'var(--text-muted)',
            }}
          >
            {enabled ? 'SCANNING' : 'IDLE'}
          </span>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-inter text-[12px]" style={{ color: 'var(--text-secondary)' }}>Enable scanning</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Writes suggestions to correlated_pair_suggestions only — manual approval required
            </p>
          </div>
          <button
            onClick={handleToggle}
            disabled={saving}
            className="relative inline-flex items-center rounded-full transition-colors duration-200 focus:outline-none"
            style={{
              width: 40,
              height: 22,
              background: enabled ? 'var(--profit)' : 'var(--border-strong)',
              opacity: saving ? 0.6 : 1,
              cursor: saving ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
            aria-label={enabled ? 'Disable pair discovery' : 'Enable pair discovery'}
          >
            <span
              style={{
                display: 'block',
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: 'white',
                transform: enabled ? 'translateX(20px)' : 'translateX(3px)',
                transition: 'transform 0.2s',
              }}
            />
          </button>
        </div>

        {/* Interval input */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-inter text-[12px]" style={{ color: 'var(--text-secondary)' }}>Scan interval (hours)</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Time between successive discovery runs
            </p>
          </div>
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={intervalHours}
            onChange={(e) => setIntervalHours(e.target.value)}
            onBlur={handleIntervalBlur}
            disabled={saving}
            className="font-jb text-[12px] text-right rounded px-2 py-1"
            style={{
              width: 72,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-strong)',
              color: 'var(--text-primary)',
              opacity: saving ? 0.6 : 1,
            }}
          />
        </div>

        {/* Status feedback */}
        {error && (
          <p className="font-inter text-[10px]" style={{ color: 'var(--loss)' }}>{error}</p>
        )}
        {saved && !error && (
          <p className="font-inter text-[10px]" style={{ color: 'var(--profit)' }}>Saved — takes effect within 2 minutes</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ConfigPanel
// ---------------------------------------------------------------------------

export function ConfigPanel({ config }: ConfigPanelProps) {
  if (!config) {
    return (
      <div className="s-card px-5 py-4">
        <p className="font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>Loading configuration…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Read-only runtime config snapshot */}
      <div className="s-card">
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between">
            <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Configuration</h2>
            <span
              className="font-jb text-[9px] px-2 py-0.5 rounded-full"
              style={{
                background: config.dryRun ? 'rgba(91,155,208,0.12)' : 'rgba(74,222,128,0.1)',
                border: `1px solid ${config.dryRun ? 'rgba(91,155,208,0.3)' : 'rgba(74,222,128,0.25)'}`,
                color: config.dryRun ? 'var(--riskfree)' : 'var(--profit)',
              }}
            >
              {config.dryRun ? 'DRY RUN' : 'LIVE'}
            </span>
          </div>
        </div>

        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>General</p>
            <Row label="Mode"    value={config.dryRun ? 'Dry Run' : 'Live'} />
            <Row label="Capital" value={`$${config.capital?.totalUsd ?? 0}`} />
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Risk</p>
            <Row label="Daily max loss"     value={`${config.risk?.dailyMaxLossPct ?? 10}%`} />
            <Row label="Max consec. losses" value={String(config.risk?.maxConsecutiveLosses ?? 6)} />
            <Row label="Pause duration"     value={`${config.risk?.pauseOnBreachMinutes ?? 30}m`} />
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Strategies</p>
            <Row label="DipArb"        value={config.dipArb?.enabled ? 'Enabled' : 'Disabled'} />
            <Row label="Logic Arb"     value={config.logicArb?.enabled ? 'Enabled' : 'Disabled'} />
            <Row label="Sportsbook"    value={config.sportsbookArb?.enabled ? 'Enabled' : 'Disabled'} />
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Integrations</p>
            <Row label="Binance K-lines" value={config.binance?.enabled ? 'Enabled' : 'Disabled'} />
            <Row label="Network"         value="Polygon" />
          </div>
        </div>

        <div className="px-5 pb-4">
          <p className="font-jb text-[9px] text-center" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            Loaded from bot-config.ts · Restart to apply changes
          </p>
        </div>
      </div>

      {/* Pair Discovery — interactive card */}
      <PairDiscoveryCard config={config} />
    </div>
  );
}
