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

  const daily = state?.dailyPnL ?? 0;
  const realized = state?.totalPnL ?? 0;
  const unrealized = state?.unrealizedPnL ?? 0;
  const total = realized + unrealized;

  const arb = state?.arbProfit ?? 0;
  const consecutiveLosses = state?.consecutiveLosses ?? 0;
  const maxLosses = config?.risk?.maxConsecutiveLosses ?? 6;
  const riskLevel = maxLosses > 0 ? consecutiveLosses / maxLosses : 0;

  useEffect(() => {
    setPnlHistory(prev => [...prev, total].slice(-MAX_PNL_HISTORY));
  }, [total]);

  const riskBarColor = riskLevel >= 0.8 ? 'bg-red-500' : riskLevel >= 0.5 ? 'bg-yellow-500' : 'bg-emerald-500';
  const riskTextColor = riskLevel >= 0.8 ? 'text-red-400' : riskLevel >= 0.5 ? 'text-yellow-400' : 'text-emerald-400';

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-white/25 mb-1">
            Realized + Open
          </p>
          <h2 className="text-base font-semibold text-white/90">P&amp;L</h2>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
          total >= 0
            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
            : 'bg-red-500/10 border-red-500/25 text-red-300'
        }`}>
          {total >= 0 ? '▲' : '▼'} {total >= 0 ? '+' : ''}{total.toFixed(2)}
        </span>
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-5">
        {/* Main figure */}
        <div>
          <p className="text-[10px] text-white/25 mb-1">Total P&amp;L</p>
          <AnimatedCounter
            value={total}
            colorize
            prefix="$"
            decimals={2}
            className="text-4xl font-bold font-mono"
          />
          {unrealized !== 0 && (
            <p className="text-[10px] text-white/30 mt-1">
              Realized <span className="font-mono">${realized.toFixed(2)}</span>
              {' · '}Open <span className="font-mono">${unrealized.toFixed(2)}</span>
            </p>
          )}
        </div>

        {/* Today */}
        <div className="stat-row">
          <span className="stat-label">Today</span>
          <AnimatedCounter
            value={daily}
            colorize
            prefix="$"
            decimals={2}
            className="text-sm font-mono font-semibold"
          />
        </div>

        {/* Arb profit */}
        <div className="stat-row">
          <span className="stat-label">Arb profit</span>
          <AnimatedCounter
            value={arb}
            colorize
            prefix="$"
            decimals={2}
            className="text-sm font-mono font-semibold"
          />
        </div>

        {/* Sparkline */}
        {pnlHistory.length > 1 && (
          <div>
            <p className="text-[10px] text-white/25 mb-2">Session curve</p>
            <Sparkline
              data={pnlHistory}
              width={240}
              height={40}
              color={total >= 0 ? 'green' : 'red'}
            />
          </div>
        )}

        <div className="inner-divider" />

        {/* Risk meter */}
        <div>
          <div className="flex justify-between text-[10px] text-white/30 mb-1.5">
            <span>Consecutive losses</span>
            <span>
              <span className={`font-mono font-semibold ${riskTextColor}`}>{consecutiveLosses}</span>
              <span className="text-white/20"> / {maxLosses}</span>
            </span>
          </div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${riskBarColor}`}
              style={{ width: `${Math.min(100, riskLevel * 100)}%` }}
            />
          </div>
          <p className="text-[9px] text-white/20 mt-1">Auto-pause at {maxLosses}</p>
        </div>
      </div>
    </div>
  );
}
