import type { BotConfig } from '../types';

interface StrategyControlsProps {
  config: BotConfig | null;
  onToggle: (strategy: string, enabled: boolean) => void;
}

interface ToggleRowProps {
  label: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({ label, enabled, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="s-stat-row">
      <span className="font-inter text-xs" style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
        {label}
      </span>
      <button
        onClick={() => !disabled && onChange(!enabled)}
        className="relative w-9 h-5 rounded-full transition-colors"
        style={{
          background: enabled ? (disabled ? 'rgba(91,155,208,0.3)' : 'var(--riskfree)') : 'var(--border-strong)',
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        <div
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200"
          style={{ left: enabled ? 'calc(100% - 18px)' : '2px' }}
        />
      </button>
    </div>
  );
}

export function StrategyControls({ config, onToggle }: StrategyControlsProps) {
  if (!config) return null;

  return (
    <div className="s-card">
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Strategy Controls</h3>
      </div>
      <div className="px-5 py-4 space-y-3">
        <ToggleRow
          label="DipArb (Crypto Short-Term)"
          enabled={config.dipArb?.enabled ?? false}
          onChange={(v) => onToggle('dipArb', v)}
        />
        <div className="pt-1" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="font-jb text-[9px] uppercase tracking-wider mb-2 mt-1" style={{ color: 'var(--text-muted)' }}>
            Detection-only (env flag)
          </p>
          <div className="space-y-3">
            <ToggleRow label="NegRisk Arb"    enabled={config.negRiskArb?.enabled ?? false}    onChange={(v) => onToggle('negRiskArb', v)}    disabled />
            <ToggleRow label="Logic Arb"      enabled={config.logicArb?.enabled ?? false}      onChange={(v) => onToggle('logicArb', v)}      disabled />
            <ToggleRow label="Sportsbook Arb" enabled={config.sportsbookArb?.enabled ?? false} onChange={(v) => onToggle('sportsbookArb', v)} disabled />
          </div>
        </div>
        <p className="font-jb text-[9px] pt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
          DipArb: immediate. Detection modules: restart required.
        </p>
      </div>
    </div>
  );
}
