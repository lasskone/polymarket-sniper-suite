import type { BotState, NegRiskArbSignal } from '../types';
import type { ModuleStat } from '../hooks/usePaperStats';

interface NegRiskArbPanelProps {
  state: BotState | null;
  paperStats?: ModuleStat;
}

export function NegRiskArbPanel({ state, paperStats }: NegRiskArbPanelProps) {
  const d = state?.negRiskArb;
  const isLive = d?.status === 'scanning';

  return (
    <div className="s-card s-card-riskfree flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div>
          <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
            Risk-free · Detection only
          </p>
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            NegRisk Arb
          </h2>
          <p className="font-inter text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
            In a multi-outcome event exactly one outcome pays $1, so YES prices must sum to 1.00. Detects when that sum deviates and buys the mispriced side — guaranteed profit at resolution.
          </p>
        </div>
        {isLive ? (
          <span
            className="font-jb text-[9px] px-2 py-0.5 rounded-full animate-pulse"
            style={{ background: 'rgba(91,155,208,0.12)', border: '1px solid rgba(91,155,208,0.3)', color: 'var(--riskfree)' }}
          >
            ● LIVE
          </span>
        ) : (
          <span
            className="font-jb text-[9px] px-2 py-0.5 rounded-full"
            style={{ background: 'var(--glass)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
          >
            IDLE
          </span>
        )}
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-4">
        {/* Counters */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Events scanned</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{d?.eventsScanned ?? 0}</p>
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Candidates</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--riskfree)' }}>{d?.candidatesFound ?? 0}</p>
          </div>
        </div>

        {/* Last signal */}
        {d?.lastSignal ? (
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Last signal</p>
            <p className="font-inter text-xs font-medium mb-2 truncate" style={{ color: 'var(--text-primary)' }} title={d.lastSignal.eventTitle}>
              {d.lastSignal.eventTitle}
            </p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Direction', value: d.lastSignal.direction.toUpperCase(), color: 'var(--riskfree)' },
                { label: 'Σ YES',     value: d.lastSignal.yesSum.toFixed(3),       color: 'var(--text-secondary)' },
                { label: 'Net P&L',   value: `$${d.lastSignal.netProfitUSD.toFixed(3)}`, color: 'var(--profit)' },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <p className="font-jb text-[9px] mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
                  <p className="font-jb text-xs font-semibold" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-4 text-center">
            <p className="font-inter text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>No signals yet</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              Watching multi-outcome events…
            </p>
          </div>
        )}

        {/* Signals list */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Signals</p>
            <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{d?.recentSignals?.length ?? 0}</p>
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {(d?.recentSignals ?? []).length === 0 ? (
              <p className="font-jb text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>Waiting for signals…</p>
            ) : (
              (d?.recentSignals ?? []).slice(0, 5).map((sig: NegRiskArbSignal, i: number) => (
                <div key={`${sig.timestamp}-${i}`} className="flex items-center justify-between">
                  <span className="font-jb text-[9px] uppercase w-12" style={{ color: 'var(--riskfree)' }}>{sig.direction}</span>
                  <span className="font-inter text-[10px] truncate flex-1 mx-2" style={{ color: 'var(--text-muted)' }}>{sig.eventTitle}</span>
                  <span className="font-jb text-[9px]" style={{ color: 'var(--profit)' }}>${sig.netProfitUSD.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Performance */}
        <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(91,155,208,0.05)', border: '1px solid rgba(91,155,208,0.12)' }}>
          <div className="flex items-center justify-between mb-1.5">
            <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Performance (simulated)</p>
            <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{paperStats?.tradeCount ?? 0} trades</p>
          </div>
          <p className="font-jb text-sm font-semibold" style={{ color: (paperStats?.totalNetProfitUsd ?? 0) >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
            {(paperStats?.totalNetProfitUsd ?? 0) >= 0 ? '+' : ''}${(paperStats?.totalNetProfitUsd ?? 0).toFixed(4)}
          </p>
          <p className="font-inter text-[9px] mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            Simulated — no real money moved
          </p>
        </div>

        {/* Config */}
        <details className="s-config">
          <summary className="flex items-center gap-1.5">
            <span className="s-chevron font-jb text-[8px]" style={{ color: 'var(--text-muted)' }}>▶</span>
            <span className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Config</span>
          </summary>
          <div className="mt-2 pl-3 space-y-1.5" style={{ borderLeft: '1px solid var(--border)' }}>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Min net profit</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>$0.05</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Scan interval</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>30 s</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Outcome range</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>3 – 25</span></div>
            <p className="font-jb text-[9px] mt-1 italic" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>hardcoded — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
