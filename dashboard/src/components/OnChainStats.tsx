import type { BotState } from '../types';

interface OnChainStatsProps {
  state: BotState | null;
}

export function OnChainStats({ state }: OnChainStatsProps) {
  const splits  = state?.splits  ?? 0;
  const merges  = state?.merges  ?? 0;
  const redeems = state?.redeems ?? 0;
  const swaps   = state?.swaps   ?? 0;
  const total   = splits + merges + redeems + swaps;

  const stats = [
    { label: 'Splits',  value: splits  },
    { label: 'Merges',  value: merges  },
    { label: 'Redeems', value: redeems },
    { label: 'Swaps',   value: swaps   },
  ];

  return (
    <div className="s-card px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>On-Chain Ops</h3>
        <span className="font-jb text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{total}</span>
      </div>

      {/* Stacked bar */}
      <div className="flex h-1 rounded-full overflow-hidden mb-3" style={{ background: 'var(--border-strong)' }}>
        {stats.map((s, i) => {
          const colors = ['#a78bfa', 'var(--riskfree)', 'var(--profit)', '#f59e0b'];
          return (
            <div
              key={s.label}
              className="h-full transition-all duration-500"
              style={{
                width: total > 0 ? `${(s.value / total) * 100}%` : '25%',
                background: colors[i],
              }}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="text-center">
            <p className="font-jb text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{s.value}</p>
            <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
