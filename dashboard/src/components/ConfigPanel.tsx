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

export function ConfigPanel({ config }: ConfigPanelProps) {
  if (!config) {
    return (
      <div className="s-card px-5 py-4">
        <p className="font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>Loading configuration…</p>
      </div>
    );
  }

  return (
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
          <Row label="NegRisk Arb"   value={config.negRiskArb?.enabled ? 'Enabled' : 'Disabled'} />
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
  );
}
