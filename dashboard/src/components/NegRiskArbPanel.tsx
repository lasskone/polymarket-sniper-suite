import type { BotState, NegRiskArbSignal } from '../types';

interface NegRiskArbPanelProps {
  state: BotState | null;
}

export function NegRiskArbPanel({ state }: NegRiskArbPanelProps) {
  const negRiskArb = state?.negRiskArb;
  const isLive = negRiskArb?.status === 'scanning';

  const getSignalStyle = (direction: string) => {
    const d = direction.toLowerCase();
    if (d === 'yes' || d === 'up' || d === 'overbought') {
      return 'bg-red-500/10 border-red-500/30 text-red-400';
    }
    return 'bg-blue-500/10 border-blue-500/30 text-blue-400';
  };

  const formatDeviation = (dev: number) => {
    const pct = (dev * 100).toFixed(2);
    return dev > 0 ? `+${pct}%` : `${pct}%`;
  };

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-orange-500/20 to-red-500/20">
            ⚖️
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-orange-400 uppercase tracking-wider font-medium">Detection Only</span>
            <span>NegRisk Arb</span>
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
        <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-orange-300 flex items-center gap-2">
          <span>🔍</span>
          <span>Detection only — no live execution</span>
        </div>

        {/* Scan counters */}
        <div className="bg-poly-dark/50 rounded-xl p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-4">Scanner Stats</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Events Scanned</div>
              <div className="text-2xl font-mono font-bold text-white">
                {negRiskArb?.eventsScanned ?? 0}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Candidates</div>
              <div className="text-2xl font-mono font-bold text-orange-400">
                {negRiskArb?.candidatesFound ?? 0}
              </div>
            </div>
          </div>
        </div>

        {/* Last signal highlight */}
        {negRiskArb?.lastSignal ? (
          <div className="bg-poly-dark/50 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Last Signal</div>
            <div className="text-sm text-white font-medium mb-2 truncate" title={negRiskArb.lastSignal.eventTitle}>
              {negRiskArb.lastSignal.eventTitle}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Direction</div>
                <div className="text-orange-400 font-semibold uppercase">{negRiskArb.lastSignal.direction}</div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Σ YES</div>
                <div className="text-white font-mono">{negRiskArb.lastSignal.yesSum.toFixed(3)}</div>
              </div>
              <div className="text-center">
                <div className="text-gray-500 mb-0.5">Net P&amp;L</div>
                <div className="text-green-400 font-mono font-semibold">
                  ${negRiskArb.lastSignal.netProfitUSD.toFixed(3)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-poly-dark/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-2">🔍</div>
            <div className="text-gray-400 text-sm">No signals yet</div>
            <div className="text-xs text-gray-500 mt-1">Waiting for mispriced NegRisk events...</div>
          </div>
        )}

        {/* Recent signals list */}
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-3 flex items-center justify-between">
            <span>Recent Signals</span>
            <span className="text-gray-600">{negRiskArb?.recentSignals?.length ?? 0} total</span>
          </div>
          <div className="space-y-2 max-h-36 overflow-y-auto">
            {(negRiskArb?.recentSignals ?? []).length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4 bg-poly-dark/30 rounded-lg">
                Waiting for signals...
              </div>
            ) : (
              (negRiskArb?.recentSignals ?? []).slice(0, 5).map((signal: NegRiskArbSignal, i: number) => (
                <div
                  key={`${signal.timestamp}-${i}`}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${getSignalStyle(signal.direction)}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold uppercase text-xs shrink-0">{signal.direction}</span>
                    <span className="text-gray-400 truncate text-xs">{signal.eventTitle}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs shrink-0 ml-2">
                    <span className="text-gray-400">{formatDeviation(signal.deviation)}</span>
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
