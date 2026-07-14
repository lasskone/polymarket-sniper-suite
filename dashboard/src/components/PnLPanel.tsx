import { useState, useEffect } from 'react';
import type { BotState, BotConfig } from '../types';
import { Sparkline } from './Sparkline';
import { AnimatedCounter } from './AnimatedCounter';

interface PnLPanelProps {
  state: BotState | null;
  config: BotConfig | null;
}

const MAX_PNL_HISTORY = 30;

export function PnLPanel({ state, config }: PnLPanelProps) {
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);

  const daily       = state?.dailyPnL ?? 0;
  const realized    = state?.totalPnL ?? 0;
  const unrealized  = state?.unrealizedPnL ?? 0;
  const total       = realized + unrealized;
  const arb         = state?.arbProfit ?? 0;
  const consecutiveLosses = state?.consecutiveLosses ?? 0;
  const maxLosses   = config?.risk?.maxConsecutiveLosses ?? 6;
  const riskLevel   = maxLosses > 0 ? consecutiveLosses / maxLosses : 0;

  useEffect(() => {
    setPnlHistory(prev => [...prev, total].slice(-MAX_PNL_HISTORY));
  }, [total]);

  const pnlColor    = total >= 0 ? 'var(--profit)' : 'var(--loss)';
  const riskColor   = riskLevel >= 0.8 ? 'var(--loss)' : riskLevel >= 0.5 ? '#f59e0b' : 'var(--profit)';

  return (
    <div className="s-card flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div>
          <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
            Realized + open
          </p>
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            P&amp;L
          </h2>
        </div>
        <span
          className="font-jb text-[9px] px-2 py-0.5 rounded-full"
          style={{
            background: total >= 0 ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
            border: `1px solid ${total >= 0 ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.25)'}`,
            color: pnlColor,
          }}
        >
          {total >= 0 ? '▲' : '▼'} {total >= 0 ? '+' : ''}{total.toFixed(2)}
        </span>
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-4">
        {/* Main figure */}
        <div>
          <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Total P&amp;L</p>
          <AnimatedCounter
            value={total}
            colorize
            prefix="$"
            decimals={2}
            className="font-jb text-4xl font-semibold"
          />
          {unrealized !== 0 && (
            <p className="font-jb text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Realized <span style={{ color: 'var(--text-secondary)' }}>${realized.toFixed(2)}</span>
              {' · '}
              Open <span style={{ color: 'var(--text-secondary)' }}>${unrealized.toFixed(2)}</span>
            </p>
          )}
        </div>

        {/* Sub-rows */}
        <div className="space-y-2">
          <div className="s-stat-row">
            <span className="font-inter text-[11px]" style={{ color: 'var(--text-muted)' }}>Today</span>
            <AnimatedCounter
              value={daily}
              colorize
              prefix="$"
              decimals={2}
              className="font-jb text-sm font-semibold"
            />
          </div>
          <div className="s-stat-row">
            <span className="font-inter text-[11px]" style={{ color: 'var(--text-muted)' }}>Arb profit</span>
            <AnimatedCounter
              value={arb}
              colorize
              prefix="$"
              decimals={2}
              className="font-jb text-sm font-semibold"
            />
          </div>
        </div>

        {/* Sparkline */}
        {pnlHistory.length > 1 && (
          <div>
            <p className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Session curve</p>
            <Sparkline
              data={pnlHistory}
              width={240}
              height={36}
              color={total >= 0 ? 'green' : 'red'}
            />
          </div>
        )}

        {/* Risk meter */}
        <div>
          <div className="flex justify-between font-jb text-[9px] mb-1.5">
            <span style={{ color: 'var(--text-muted)' }}>Consecutive losses</span>
            <span>
              <span style={{ color: riskColor }}>{consecutiveLosses}</span>
              <span style={{ color: 'var(--text-muted)' }}> / {maxLosses}</span>
            </span>
          </div>
          <div className="h-px rounded-full" style={{ background: 'var(--border-strong)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, riskLevel * 100)}%`, background: riskColor }}
            />
          </div>
          <p className="font-jb text-[9px] mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            Auto-pause at {maxLosses}
          </p>
        </div>
      </div>
    </div>
  );
}
