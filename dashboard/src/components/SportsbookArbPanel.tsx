import type { BotState, SportsbookArbDashboardSignal } from '../types';
import type { SportsbookStat } from '../hooks/usePaperStats';

interface SportsbookArbPanelProps {
  state: BotState | null;
  sbPaperStats?: SportsbookStat;
}

export function SportsbookArbPanel({ state, sbPaperStats }: SportsbookArbPanelProps) {
  const sbArb = state?.sportsbookArb;
  const isLive = sbArb?.status === 'scanning';
  const coveragePct = (sbArb?.polymarketCoverageRatio ?? 0) * 100;

  return (
    <div className="s-card s-card-directional">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div>
          <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
            Directional · Detection only
          </p>
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Sportsbook Arb
          </h2>
          <p className="font-inter text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
            De-vigs Pinnacle's sharp odds to a fair probability, then signals when Polymarket's price is materially below that fair value — an edge, not a lock.
          </p>
        </div>
        {isLive ? (
          <span
            className="font-jb text-[9px] px-2 py-0.5 rounded-full animate-pulse"
            style={{ background: 'rgba(217,150,47,0.12)', border: '1px solid rgba(217,150,47,0.3)', color: 'var(--directional)' }}
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

      {/* Warning strip */}
      <div
        className="mx-5 mb-4 flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ background: 'rgba(217,150,47,0.07)', border: '1px solid rgba(217,150,47,0.18)' }}
      >
        <span className="text-sm">⚡</span>
        <p className="font-jb text-[9px]" style={{ color: 'rgba(217,150,47,0.8)' }}>
          Not risk-free — directional bet on mispriced odds vs Pinnacle
        </p>
      </div>

      <div className="px-5 pb-5 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: counters + coverage */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Fixtures</p>
              <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{sbArb?.fixturesScanned ?? 0}</p>
            </div>
            <div>
              <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Coverage</p>
              <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--directional)' }}>{coveragePct.toFixed(1)}%</p>
            </div>
          </div>
          <div>
            <div className="flex justify-between font-jb text-[9px] mb-1" style={{ color: 'var(--text-muted)' }}>
              <span>Polymarket coverage</span><span>{coveragePct.toFixed(1)}%</span>
            </div>
            <div className="h-px rounded-full" style={{ background: 'var(--border-strong)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, coveragePct)}%`, background: 'rgba(217,150,47,0.6)' }}
              />
            </div>
          </div>
        </div>

        {/* Center: last signal */}
        <div>
          <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Last signal</p>
          {sbArb?.lastSignal ? (
            <>
              <p className="font-inter text-xs font-medium truncate mb-0.5" style={{ color: 'var(--text-primary)' }}>
                {sbArb.lastSignal.participant1Name} <span style={{ color: 'var(--text-muted)' }}>vs</span> {sbArb.lastSignal.participant2Name}
              </p>
              <p className="font-jb text-[10px] truncate mb-1" style={{ color: 'var(--text-muted)' }}>{sbArb.lastSignal.tournamentName}</p>
              <p className="font-jb text-[10px] mb-2" style={{ color: 'var(--directional)' }}>
                Outcome: {sbArb.lastSignal.outcomeName}
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  { label: 'Edge',   value: `${(sbArb.lastSignal.edge * 100).toFixed(1)}pp`,          color: 'var(--directional)' },
                  { label: 'E[Net]', value: `$${sbArb.lastSignal.expectedNetProfitUSD.toFixed(3)}`,   color: 'var(--profit)' },
                  { label: 'Conf',   value: `${(sbArb.lastSignal.confidence * 100).toFixed(0)}%`,     color: 'var(--text-secondary)' },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <p className="font-jb text-[9px] mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
                    <p className="font-jb text-xs font-semibold" style={{ color }}>{value}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-4 text-center">
              <p className="font-inter text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>No signals yet</p>
              <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                Comparing Pinnacle vs Polymarket odds…
              </p>
            </div>
          )}
        </div>

        {/* Right: signals list + config */}
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex justify-between items-center mb-2">
              <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Signals</p>
              <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{sbArb?.recentSignals?.length ?? 0}</p>
            </div>
            <div className="space-y-1 max-h-28 overflow-y-auto">
              {(sbArb?.recentSignals ?? []).length === 0 ? (
                <p className="font-jb text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>Waiting for signals…</p>
              ) : (
                (sbArb?.recentSignals ?? []).slice(0, 5).map((sig: SportsbookArbDashboardSignal, i: number) => (
                  <div key={`${sig.timestamp}-${i}`} className="flex items-center justify-between gap-2">
                    <span className="font-inter text-[10px] truncate flex-1" style={{ color: 'var(--text-muted)' }}>
                      {sig.participant1Name} vs {sig.participant2Name}
                    </span>
                    <span className="font-jb text-[9px] shrink-0" style={{ color: 'var(--directional)' }}>
                      {(sig.edge * 100).toFixed(1)}pp
                    </span>
                    <span className="font-jb text-[9px] shrink-0" style={{ color: 'var(--profit)' }}>
                      ${sig.expectedNetProfitUSD.toFixed(2)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Performance */}
          <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(217,150,47,0.05)', border: '1px solid rgba(217,150,47,0.12)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Performance (simulated)</p>
              <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {(sbPaperStats?.openCount ?? 0) > 0
                  ? `${sbPaperStats!.openCount} open`
                  : `${(sbPaperStats?.wonCount ?? 0) + (sbPaperStats?.lostCount ?? 0)} settled`}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mb-1.5">
              <div>
                <p className="font-jb text-[9px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Open</p>
                <p className="font-jb text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{sbPaperStats?.openCount ?? 0}</p>
              </div>
              <div>
                <p className="font-jb text-[9px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Won</p>
                <p className="font-jb text-xs font-semibold" style={{ color: 'var(--profit)' }}>{sbPaperStats?.wonCount ?? 0}</p>
              </div>
              <div>
                <p className="font-jb text-[9px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Lost</p>
                <p className="font-jb text-xs font-semibold" style={{ color: 'var(--loss)' }}>{sbPaperStats?.lostCount ?? 0}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="font-jb text-sm font-semibold" style={{ color: (sbPaperStats?.settledNetProfitUsd ?? 0) >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
                {(sbPaperStats?.settledNetProfitUsd ?? 0) >= 0 ? '+' : ''}${(sbPaperStats?.settledNetProfitUsd ?? 0).toFixed(4)}
              </p>
              {sbPaperStats?.winRate != null && (
                <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {(sbPaperStats.winRate * 100).toFixed(0)}% win rate
                </p>
              )}
            </div>
            <p className="font-inter text-[9px] mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
              Simulated — no real money moved
            </p>
          </div>

          <details className="s-config">
            <summary className="flex items-center gap-1.5">
              <span className="s-chevron font-jb text-[8px]" style={{ color: 'var(--text-muted)' }}>▶</span>
              <span className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Config</span>
            </summary>
            <div className="mt-2 pl-3 space-y-1.5" style={{ borderLeft: '1px solid var(--border)' }}>
              <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Min edge</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>5%</span></div>
              <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Min profit</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>$0.05</span></div>
              <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Sports</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>NBA · Soccer</span></div>
              <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Scan interval</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>5 min</span></div>
              <p className="font-jb text-[9px] mt-1 italic" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>hardcoded — not adjustable from dashboard</p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
