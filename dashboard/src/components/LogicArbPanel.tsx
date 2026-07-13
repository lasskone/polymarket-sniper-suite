import type { BotState, LogicArbDashboardSignal } from '../types';

interface LogicArbPanelProps {
  state: BotState | null;
}

export function LogicArbPanel({ state }: LogicArbPanelProps) {
  const logicArb = state?.logicArb;
  const isLive = logicArb?.status === 'scanning';

  const getRelLabel = (relationship: string) => {
    if (relationship === 'a_implies_b') return 'A→B';
    if (relationship === 'mutually_exclusive') return 'MUTEX';
    return relationship.toUpperCase();
  };

  const getRelStyle = (relationship: string) => {
    if (relationship === 'mutually_exclusive') {
      return 'bg-red-500/10 border-red-500/30 text-red-400';
    }
    return 'bg-blue-500/10 border-blue-500/30 text-blue-400';
  };

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-violet-500/20 to-purple-500/20">
            🔗
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-violet-400 uppercase tracking-wider font-medium">Detection Only</span>
            <span>Logic Arb</span>
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
        <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-violet-300 flex items-center gap-2">
          <span>🔍</span>
          <span>Detection only — no live execution</span>
        </div>

        {/* Scan counters */}
        <div className="bg-poly-dark/50 rounded-xl p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-4">Scanner Stats</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Pairs Tracked</div>
              <div className="text-2xl font-mono font-bold text-white">
                {logicArb?.pairsTracked ?? 0}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Scanned</div>
              <div className="text-2xl font-mono font-bold text-violet-400">
                {logicArb?.pairsScanned ?? 0}
              </div>
            </div>
          </div>
        </div>

        {/* Last signal highlight */}
        {logicArb?.lastSignal ? (
          <div className="bg-poly-dark/50 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Last Signal</div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${getRelStyle(logicArb.lastSignal.relationship)}`}>
                {getRelLabel(logicArb.lastSignal.relationship)}
              </span>
            </div>
            <div className="text-xs text-gray-400 mb-1 truncate" title={logicArb.lastSignal.marketASlug}>
              A: {logicArb.lastSignal.marketASlug}
            </div>
            <div className="text-xs text-gray-400 mb-3 truncate" title={logicArb.lastSignal.marketBSlug}>
              B: {logicArb.lastSignal.marketBSlug}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">P(A)</div>
                <div className="text-white font-mono">{logicArb.lastSignal.priceA.toFixed(3)}</div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">P(B)</div>
                <div className="text-white font-mono">{logicArb.lastSignal.priceB.toFixed(3)}</div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Net P&amp;L</div>
                <div className="text-green-400 font-mono font-semibold">
                  ${logicArb.lastSignal.netProfitUSD.toFixed(3)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-poly-dark/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-2">🔍</div>
            <div className="text-gray-400 text-sm">No signals yet</div>
            <div className="text-xs text-gray-500 mt-1">Watching correlated market pairs...</div>
          </div>
        )}

        {/* Recent signals list */}
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-3 flex items-center justify-between">
            <span>Recent Signals</span>
            <span className="text-gray-600">{logicArb?.recentSignals?.length ?? 0} total</span>
          </div>
          <div className="space-y-2 max-h-36 overflow-y-auto">
            {(logicArb?.recentSignals ?? []).length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4 bg-poly-dark/30 rounded-lg">
                Waiting for signals...
              </div>
            ) : (
              (logicArb?.recentSignals ?? []).slice(0, 5).map((signal: LogicArbDashboardSignal, i: number) => (
                <div
                  key={`${signal.timestamp}-${i}`}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${getRelStyle(signal.relationship)}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-xs shrink-0">{getRelLabel(signal.relationship)}</span>
                    <span className="text-gray-400 truncate text-xs">{signal.marketASlug}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs shrink-0 ml-2">
                    <span className="text-gray-400">{(signal.deviation * 100).toFixed(1)}%</span>
                    <span className="text-green-400">${signal.netProfitUSD.toFixed(2)}</span>
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
