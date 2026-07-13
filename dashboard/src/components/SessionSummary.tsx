import type { BotState } from '../types';

interface SessionSummaryProps {
  state: BotState | null;
}

export function SessionSummary({ state }: SessionSummaryProps) {
  const trades = state?.tradesExecuted ?? 0;
  const totalPnL = state?.totalPnL ?? 0;
  const arbProfit = state?.arbProfit ?? 0;
  const dipArbTrades = state?.dipArbTrades ?? 0;

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-full">
      <div className="px-5 pt-5 pb-4">
        <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-white/25 mb-1">This session</p>
        <h2 className="text-base font-semibold text-white/90">Summary</h2>
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-4">
        {/* Key figures */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Trades</p>
            <p className="text-2xl font-bold font-mono text-white/80">{trades}</p>
          </div>
          <div>
            <p className="text-[10px] text-white/30 mb-1 font-medium uppercase tracking-wider">Net P&amp;L</p>
            <p className={`text-2xl font-bold font-mono ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
            </p>
          </div>
        </div>

        <div className="inner-divider" />

        {/* Strategy breakdown */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30 mb-2.5">By strategy</p>

          <div className="stat-row">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/60" />
              <span className="text-xs text-white/40">Arb profit</span>
            </div>
            <span className={`font-mono text-xs font-medium ${arbProfit >= 0 ? 'text-emerald-300' : 'text-red-400'}`}>
              {arbProfit >= 0 ? '+' : ''}{arbProfit.toFixed(2)}
            </span>
          </div>

          <div className="stat-row">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400/60" />
              <span className="text-xs text-white/40">DipArb trades</span>
            </div>
            <span className="font-mono text-xs text-white/50">{dipArbTrades}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
