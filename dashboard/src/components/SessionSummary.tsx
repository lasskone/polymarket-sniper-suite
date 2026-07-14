import type { BotState } from '../types';

interface SessionSummaryProps {
  state: BotState | null;
}

export function SessionSummary({ state }: SessionSummaryProps) {
  const trades     = state?.tradesExecuted ?? 0;
  const totalPnL   = state?.totalPnL ?? 0;
  const arbProfit  = state?.arbProfit ?? 0;
  const dipArbTrades = state?.dipArbTrades ?? 0;

  return (
    <div className="s-card flex flex-col h-full">
      <div className="px-5 pt-5 pb-3">
        <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>This session</p>
        <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Summary</h2>
      </div>
      <div className="px-5 pb-5 flex-1 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Trades</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{trades}</p>
          </div>
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Net P&amp;L</p>
            <p className="font-jb text-2xl font-semibold" style={{ color: totalPnL >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
              {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
            </p>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)' }} />

        <div className="space-y-2">
          <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>By strategy</p>
          <div className="s-stat-row">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(74,222,128,0.6)' }} />
              <span className="font-inter text-xs" style={{ color: 'var(--text-muted)' }}>Arb profit</span>
            </div>
            <span className="font-jb text-xs font-semibold" style={{ color: arbProfit >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
              {arbProfit >= 0 ? '+' : ''}{arbProfit.toFixed(2)}
            </span>
          </div>
          <div className="s-stat-row">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(91,155,208,0.6)' }} />
              <span className="font-inter text-xs" style={{ color: 'var(--text-muted)' }}>DipArb trades</span>
            </div>
            <span className="font-jb text-xs" style={{ color: 'var(--text-secondary)' }}>{dipArbTrades}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
