import type { BotState, SportsbookArbDashboardSignal } from '../types';

interface SportsbookArbPanelProps {
  state: BotState | null;
}

export function SportsbookArbPanel({ state }: SportsbookArbPanelProps) {
  const sbArb = state?.sportsbookArb;
  const isLive = sbArb?.status === 'scanning';

  const coveragePct = ((sbArb?.polymarketCoverageRatio ?? 0) * 100).toFixed(1);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-cyan-500/20 to-blue-500/20">
            🏆
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-cyan-400 uppercase tracking-wider font-medium">Detection Only</span>
            <span>Sportsbook Arb</span>
          </div>
        </h2>
        {isLive ? (
          <span className="badge badge-green animate-pulse">● LIVE</span>
        ) : (
          <span className="badge bg-gray-500/20 text-gray-400 border border-gray-500/30">IDLE</span>
        )}
      </div>

      <div className="panel-body space-y-5">
        {/* Detection-only notice */}
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-xs text-yellow-300 flex items-center gap-2">
          <span>⚠️</span>
          <span>Detection only — directional bet, NOT risk-free</span>
        </div>

        {/* Scan counters */}
        <div className="bg-poly-dark/50 rounded-xl p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-4">Scanner Stats</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Fixtures Scanned</div>
              <div className="text-2xl font-mono font-bold text-white">
                {sbArb?.fixturesScanned ?? 0}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Poly Coverage</div>
              <div className="text-2xl font-mono font-bold text-cyan-400">
                {coveragePct}%
              </div>
            </div>
          </div>

          {/* Coverage bar */}
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-cyan-500 transition-all duration-500"
                style={{ width: `${coveragePct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Last signal highlight */}
        {sbArb?.lastSignal ? (
          <div className="bg-poly-dark/50 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Last Signal</div>
            <div className="text-sm text-white font-medium mb-0.5">
              {sbArb.lastSignal.participant1Name} <span className="text-gray-500">vs</span> {sbArb.lastSignal.participant2Name}
            </div>
            <div className="text-xs text-gray-500 mb-3">{sbArb.lastSignal.tournamentName}</div>
            <div className="text-xs text-gray-300 mb-3 bg-poly-dark/80 rounded px-2 py-1">
              Outcome: <span className="text-white font-medium">{sbArb.lastSignal.outcomeName}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Edge</div>
                <div className="text-cyan-400 font-mono font-semibold">
                  {(sbArb.lastSignal.edge * 100).toFixed(1)}pp
                </div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">E[Net]</div>
                <div className="text-green-400 font-mono font-semibold">
                  ${sbArb.lastSignal.expectedNetProfitUSD.toFixed(3)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Conf</div>
                <div className="text-white font-mono">
                  {(sbArb.lastSignal.confidence * 100).toFixed(0)}%
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-poly-dark/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-2">🔍</div>
            <div className="text-gray-400 text-sm">No signals yet</div>
            <div className="text-xs text-gray-500 mt-1">Comparing Pinnacle vs Polymarket odds...</div>
          </div>
        )}

        {/* Recent signals list */}
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-3 flex items-center justify-between">
            <span>Recent Signals</span>
            <span className="text-gray-600">{sbArb?.recentSignals?.length ?? 0} total</span>
          </div>
          <div className="space-y-2 max-h-36 overflow-y-auto">
            {(sbArb?.recentSignals ?? []).length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4 bg-poly-dark/30 rounded-lg">
                Waiting for signals...
              </div>
            ) : (
              (sbArb?.recentSignals ?? []).slice(0, 5).map((signal: SportsbookArbDashboardSignal, i: number) => (
                <div
                  key={`${signal.timestamp}-${i}`}
                  className="flex items-center justify-between px-3 py-2 rounded-lg border bg-cyan-500/10 border-cyan-500/30 text-cyan-400 text-sm"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-white font-medium truncate">
                      {signal.participant1Name} vs {signal.participant2Name}
                    </div>
                    <div className="text-[10px] text-gray-400 truncate">{signal.outcomeName}</div>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs shrink-0 ml-2">
                    <span className="text-cyan-300">{(signal.edge * 100).toFixed(1)}pp</span>
                    <span className="text-green-400">${signal.expectedNetProfitUSD.toFixed(2)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
