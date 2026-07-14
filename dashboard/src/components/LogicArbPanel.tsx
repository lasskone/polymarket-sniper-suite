import type { BotState, LogicArbDashboardSignal } from '../types';

interface LogicArbPanelProps {
  state: BotState | null;
}

export function LogicArbPanel({ state }: LogicArbPanelProps) {
  const d = state?.logicArb;
  const isLive = d?.status === 'scanning';

  const relLabel = (rel: string) =>
    rel === 'a_implies_b' ? 'A → B' : rel === 'mutually_exclusive' ? 'MUTEX' : rel.toUpperCase();

  return (
    <div className="s-card s-card-riskfree flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div>
          <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
            Risk-free · Detection only
          </p>
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Logic Arb
          </h2>
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
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Pairs tracked</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{d?.pairsTracked ?? 0}</p>
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Pairs scanned</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--riskfree)' }}>{d?.pairsScanned ?? 0}</p>
          </div>
        </div>

        {/* Last signal */}
        {d?.lastSignal ? (
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Last signal</p>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="font-jb text-[9px] px-1.5 py-0.5 rounded"
                style={{ border: '1px solid rgba(91,155,208,0.3)', color: 'var(--riskfree)' }}
              >
                {relLabel(d.lastSignal.relationship)}
              </span>
            </div>
            <p className="font-jb text-[10px] truncate mb-0.5" style={{ color: 'var(--text-muted)' }} title={d.lastSignal.marketASlug}>A: {d.lastSignal.marketASlug}</p>
            <p className="font-jb text-[10px] truncate mb-2" style={{ color: 'var(--text-muted)' }} title={d.lastSignal.marketBSlug}>B: {d.lastSignal.marketBSlug}</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'P(A)',    value: d.lastSignal.priceA.toFixed(3),           color: 'var(--text-secondary)' },
                { label: 'P(B)',    value: d.lastSignal.priceB.toFixed(3),           color: 'var(--text-secondary)' },
                { label: 'Net P&L', value: `$${d.lastSignal.netProfitUSD.toFixed(3)}`, color: 'var(--profit)' },
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
              Watching correlated market pairs…
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
              (d?.recentSignals ?? []).slice(0, 5).map((sig: LogicArbDashboardSignal, i: number) => (
                <div key={`${sig.timestamp}-${i}`} className="flex items-center justify-between">
                  <span className="font-jb text-[9px] w-10" style={{ color: 'var(--riskfree)' }}>{relLabel(sig.relationship)}</span>
                  <span className="font-inter text-[10px] truncate flex-1 mx-2" style={{ color: 'var(--text-muted)' }}>{sig.marketASlug}</span>
                  <span className="font-jb text-[9px] mr-2" style={{ color: 'var(--text-muted)' }}>{(sig.deviation * 100).toFixed(1)}%</span>
                  <span className="font-jb text-[9px]" style={{ color: 'var(--profit)' }}>${sig.netProfitUSD.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Config */}
        <details className="s-config">
          <summary className="flex items-center gap-1.5">
            <span className="s-chevron font-jb text-[8px]" style={{ color: 'var(--text-muted)' }}>▶</span>
            <span className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Config</span>
          </summary>
          <div className="mt-2 pl-3 space-y-1.5" style={{ borderLeft: '1px solid var(--border)' }}>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Min net profit</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>$0.05</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Scan interval</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>60 s</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Fee source</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>live CLOB API</span></div>
            <p className="font-jb text-[9px] mt-1 italic" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>hardcoded — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
