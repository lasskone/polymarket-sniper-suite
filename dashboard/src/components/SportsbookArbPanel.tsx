import type { BotState, SportsbookArbDashboardSignal } from '../types';

interface SportsbookArbPanelProps {
  state: BotState | null;
}

export function SportsbookArbPanel({ state }: SportsbookArbPanelProps) {
  const sbArb = state?.sportsbookArb;
  const isLive = sbArb?.status === 'scanning';
  const coveragePct = (sbArb?.polymarketCoverageRatio ?? 0) * 100;

  return (
    <div className="glass-card card-amber rounded-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-amber-400/60 mb-1">
            Directional · Detection only
          </p>
          <h2 className="text-base font-semibold text-white/90">Sportsbook Arb</h2>
        </div>
        {isLive ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold animate-pulse">
            ● LIVE
          </span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/30 font-semibold">
            IDLE
          </span>
        )}
      </div>

      <div className="px-5 pb-5 flex flex-col gap-5">
        {/* Not risk-free warning */}
        <div className="flex items-center gap-2 bg-amber-500/8 border border-amber-500/20 rounded-xl px-3 py-2">
          <span className="text-amber-400 text-sm">⚡</span>
          <p className="text-[10px] text-amber-300/70 font-medium">Not risk-free — directional bet on mispriced odds</p>
        </div>

        {/* Scan counters + coverage bar */}
        <div>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Fixtures scanned</p>
              <p className="text-2xl font-bold font-mono text-white/80">{sbArb?.fixturesScanned ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Poly coverage</p>
              <p className="text-2xl font-bold font-mono text-amber-400">{coveragePct.toFixed(1)}%</p>
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-white/25 mb-1.5">
            <span>Polymarket coverage</span>
            <span>{coveragePct.toFixed(1)}%</span>
          </div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500/60 transition-all duration-500"
              style={{ width: `${Math.min(100, coveragePct)}%` }}
            />
          </div>
        </div>

        {/* Last signal */}
        {sbArb?.lastSignal ? (
          <div>
            <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30 mb-2">Last signal</p>
            <p className="text-xs text-white/70 font-medium truncate mb-0.5">
              {sbArb.lastSignal.participant1Name} <span className="text-white/30">vs</span> {sbArb.lastSignal.participant2Name}
            </p>
            <p className="text-[10px] text-white/35 mb-0.5 truncate">{sbArb.lastSignal.tournamentName}</p>
            <p className="text-[10px] text-amber-400/70 mb-2">Outcome: {sbArb.lastSignal.outcomeName}</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Edge', value: `${(sbArb.lastSignal.edge * 100).toFixed(1)}pp`, color: 'text-amber-400' },
                { label: 'E[Net]', value: `$${sbArb.lastSignal.expectedNetProfitUSD.toFixed(3)}`, color: 'text-emerald-300' },
                { label: 'Conf', value: `${(sbArb.lastSignal.confidence * 100).toFixed(0)}%`, color: 'text-white/60' },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center">
                  <p className="text-[9px] text-white/25 mb-0.5">{label}</p>
                  <p className={`text-xs font-mono font-semibold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-center py-3">
            <p className="text-xl opacity-20 mb-1.5">🏆</p>
            <p className="text-xs text-white/25">No signals yet</p>
            <p className="text-[10px] text-white/15 mt-0.5">Comparing Pinnacle vs Polymarket odds…</p>
          </div>
        )}

        <div className="inner-divider" />

        {/* Recent signals */}
        <div>
          <div className="flex justify-between items-center mb-2.5">
            <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30">Signals</p>
            <p className="text-[10px] text-white/20">{sbArb?.recentSignals?.length ?? 0}</p>
          </div>
          <div className="space-y-1.5 max-h-28 overflow-y-auto">
            {(sbArb?.recentSignals ?? []).length === 0 ? (
              <p className="text-[11px] text-white/20 text-center py-3">Waiting for signals…</p>
            ) : (
              (sbArb?.recentSignals ?? []).slice(0, 5).map((sig: SportsbookArbDashboardSignal, i: number) => (
                <div key={`${sig.timestamp}-${i}`} className="flex items-center justify-between text-xs">
                  <span className="text-white/45 truncate flex-1 text-[10px]">
                    {sig.participant1Name} vs {sig.participant2Name}
                  </span>
                  <span className="font-mono text-amber-400 text-[10px] shrink-0 mx-2">
                    {(sig.edge * 100).toFixed(1)}pp
                  </span>
                  <span className="font-mono text-emerald-300 text-[10px] shrink-0">
                    ${sig.expectedNetProfitUSD.toFixed(2)}
                  </span>
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
            <div className="stat-row"><span className="stat-label">Min edge</span><span className="stat-value text-xs">5%</span></div>
            <div className="stat-row"><span className="stat-label">Min net profit</span><span className="stat-value text-xs">$0.05</span></div>
            <div className="stat-row"><span className="stat-label">Sports</span><span className="stat-value text-xs">NBA · Soccer</span></div>
            <div className="stat-row"><span className="stat-label">Scan interval</span><span className="stat-value text-xs">5 min</span></div>
            <div className="stat-row"><span className="stat-label">Lookahead</span><span className="stat-value text-xs">3 days</span></div>
            <p className="text-[9px] text-white/15 mt-1.5 italic">hardcoded in service — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
