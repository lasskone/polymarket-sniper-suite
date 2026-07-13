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
    <div className="glass-card card-emerald rounded-2xl overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-emerald-400/60 mb-1">
            Risk-Free · Detection only
          </p>
          <h2 className="text-base font-semibold text-white/90">Logic Arb</h2>
        </div>
        {isLive ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold animate-pulse">
            ● LIVE
          </span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/30 font-semibold">
            IDLE
          </span>
        )}
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-5">
        {/* Scan counters */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Pairs tracked</p>
            <p className="text-2xl font-bold font-mono text-white/80">{d?.pairsTracked ?? 0}</p>
          </div>
          <div>
            <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Pairs scanned</p>
            <p className="text-2xl font-bold font-mono text-emerald-400">{d?.pairsScanned ?? 0}</p>
          </div>
        </div>

        {/* Last signal */}
        {d?.lastSignal ? (
          <div>
            <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30 mb-2">Last signal</p>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/25 text-emerald-400 font-semibold">
                {relLabel(d.lastSignal.relationship)}
              </span>
            </div>
            <p className="text-[10px] text-white/45 truncate mb-0.5" title={d.lastSignal.marketASlug}>A: {d.lastSignal.marketASlug}</p>
            <p className="text-[10px] text-white/45 truncate mb-2" title={d.lastSignal.marketBSlug}>B: {d.lastSignal.marketBSlug}</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'P(A)', value: d.lastSignal.priceA.toFixed(3), color: 'text-white/70' },
                { label: 'P(B)', value: d.lastSignal.priceB.toFixed(3), color: 'text-white/70' },
                { label: 'Net P&L', value: `$${d.lastSignal.netProfitUSD.toFixed(3)}`, color: 'text-emerald-300' },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center">
                  <p className="text-[9px] text-white/25 mb-0.5">{label}</p>
                  <p className={`text-xs font-mono font-semibold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-2">
            <p className="text-xl opacity-20 mb-1.5">🔗</p>
            <p className="text-xs text-white/25">No signals yet</p>
            <p className="text-[10px] text-white/15 mt-0.5">Watching correlated market pairs…</p>
          </div>
        )}

        <div className="inner-divider" />

        {/* Recent signals */}
        <div>
          <div className="flex justify-between items-center mb-2.5">
            <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30">Signals</p>
            <p className="text-[10px] text-white/20">{d?.recentSignals?.length ?? 0}</p>
          </div>
          <div className="space-y-1.5 max-h-28 overflow-y-auto">
            {(d?.recentSignals ?? []).length === 0 ? (
              <p className="text-[11px] text-white/20 text-center py-3">Waiting for signals…</p>
            ) : (
              (d?.recentSignals ?? []).slice(0, 5).map((sig: LogicArbDashboardSignal, i: number) => (
                <div key={`${sig.timestamp}-${i}`} className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-emerald-400 text-[9px] w-12">{relLabel(sig.relationship)}</span>
                  <span className="text-white/35 truncate flex-1 mx-2 text-[10px]">{sig.marketASlug}</span>
                  <span className="font-mono text-[10px] text-white/40 shrink-0 mr-2">{(sig.deviation * 100).toFixed(1)}%</span>
                  <span className="font-mono text-emerald-300 text-[10px] shrink-0">${sig.netProfitUSD.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="inner-divider" />

        {/* Config expandable */}
        <details className="config-details">
          <summary className="flex items-center gap-1.5 text-[10px] text-white/25 hover:text-white/45 transition-colors cursor-pointer select-none">
            <span className="chevron text-[8px]">▶</span>
            Config
          </summary>
          <div className="mt-2 space-y-1.5 pl-3 border-l border-white/[0.06]">
            <div className="stat-row"><span className="stat-label">Min net profit</span><span className="stat-value text-xs">$0.05</span></div>
            <div className="stat-row"><span className="stat-label">Scan interval</span><span className="stat-value text-xs">60 s</span></div>
            <div className="stat-row"><span className="stat-label">Fee source</span><span className="stat-value text-xs">live CLOB API</span></div>
            <div className="stat-row"><span className="stat-label">Fee cache TTL</span><span className="stat-value text-xs">10 min</span></div>
            <p className="text-[9px] text-white/15 mt-1.5 italic">hardcoded in service — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
