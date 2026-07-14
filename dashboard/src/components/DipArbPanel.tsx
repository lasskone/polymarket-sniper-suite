import { useEffect, useState } from 'react';
import type { BotState, BotConfig, DipArbSignal } from '../types';
import type { ModuleStat } from '../hooks/usePaperStats';
import { Sparkline } from './Sparkline';

interface DipArbPanelProps {
  state: BotState | null;
  config?: BotConfig | null;
  paperStats?: ModuleStat;
}

const MAX_PRICE_HISTORY = 30;

export function DipArbPanel({ state, config, paperStats }: DipArbPanelProps) {
  const [timeRemaining, setTimeRemaining] = useState<string>('--:--');
  const [progress, setProgress] = useState(0);
  const [upPriceHistory, setUpPriceHistory] = useState<number[]>([]);
  const [downPriceHistory, setDownPriceHistory] = useState<number[]>([]);
  const lastMarketRef = useState<string | null>(null);
  const dipArb = state?.dipArb;
  const isActive = dipArb?.status === 'active' || !!dipArb?.marketName;

  useEffect(() => {
    if (!dipArb?.marketName) return;
    if (lastMarketRef[0] !== dipArb.marketName) {
      setUpPriceHistory([]);
      setDownPriceHistory([]);
      lastMarketRef[1](dipArb.marketName);
    }
    if (dipArb.upPrice > 0) setUpPriceHistory(p => [...p, dipArb.upPrice].slice(-MAX_PRICE_HISTORY));
    if (dipArb.downPrice > 0) setDownPriceHistory(p => [...p, dipArb.downPrice].slice(-MAX_PRICE_HISTORY));
  }, [dipArb?.upPrice, dipArb?.downPrice, dipArb?.marketName]);

  useEffect(() => {
    if (!dipArb?.endTime) { setTimeRemaining('--:--'); setProgress(0); return; }
    const update = () => {
      const now = Date.now();
      const remaining = Math.max(0, dipArb.endTime! - now);
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      setTimeRemaining(`${m}:${s.toString().padStart(2, '0')}`);
      let durationMs = 15 * 60 * 1000;
      if (dipArb.duration) {
        const match = dipArb.duration.match(/(\d+)m/);
        if (match?.[1]) durationMs = parseInt(match[1]) * 60 * 1000;
      }
      setProgress(Math.min(100, ((durationMs - remaining) / durationMs) * 100));
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [dipArb?.endTime]);

  const sum = dipArb?.sum ?? 0;
  const sumOk    = sum > 0 && sum <= 0.92;
  const sumClose = sum > 0.92 && sum <= 0.98;

  const coins = config?.dipArb?.coins ?? ['ETH', 'BTC', 'SOL'];

  const getSignalColor = (type: DipArbSignal['type']) => {
    if (type === 'dip')   return 'var(--loss)';
    if (type === 'surge') return 'var(--profit)';
    if (type === 'leg1')  return 'var(--riskfree)';
    return '#a78bfa';
  };

  const sumColor = sumOk ? 'var(--profit)' : sumClose ? '#f59e0b' : 'var(--text-secondary)';

  return (
    <div className="s-card s-card-riskfree flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div>
          <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
            Risk-free · DipArb
          </p>
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            DipArb Monitor
          </h2>
          <p className="font-inter text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
            Buys both sides of a 5–15 min BTC/ETH/SOL market when their combined price dips below $1 — guaranteed profit at resolution.
          </p>
        </div>
        {isActive ? (
          <span
            className="font-jb text-[9px] px-2 py-0.5 rounded-full animate-pulse"
            style={{ background: 'rgba(91,155,208,0.12)', border: '1px solid rgba(91,155,208,0.3)', color: 'var(--riskfree)' }}
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

      <div className="px-5 pb-5 flex-1 flex flex-col gap-4">
        {isActive ? (
          <>
            {/* Market name */}
            <p className="font-jb text-[10px] truncate -mt-1" style={{ color: 'var(--text-secondary)' }} title={dipArb?.marketName ?? ''}>
              {dipArb?.marketName}
            </p>

            {/* Price trio */}
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'UP',   value: dipArb?.upPrice ?? 0,   color: 'var(--profit)',         history: upPriceHistory,   hcolor: 'green' as const },
                { label: 'DOWN', value: dipArb?.downPrice ?? 0, color: 'var(--loss)',            history: downPriceHistory, hcolor: 'red'   as const },
                { label: 'SUM',  value: sum,                     color: sumColor,                history: undefined,         hcolor: undefined },
              ].map(({ label, value, color, history, hcolor }) => (
                <div key={label}>
                  <p className="font-jb text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
                  <p className="font-jb text-lg font-semibold" style={{ color }}>
                    {value > 0 ? value.toFixed(3) : '—'}
                  </p>
                  {history && history.length > 1 && (
                    <div className="mt-1 flex justify-center">
                      <Sparkline data={history} width={52} height={14} color={hcolor!} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Sum status bar */}
            {sum > 0 && (
              <div>
                <div className="flex justify-between font-jb text-[9px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  <span>Sum → target ≤ 0.92</span>
                  <span style={{ color: sumColor }}>
                    {sumOk ? '🎯 Opportunity' : sumClose ? 'Close' : 'Normal'}
                  </span>
                </div>
                <div className="h-px rounded-full" style={{ background: 'var(--border-strong)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${Math.min(100, (sum / 1.05) * 100)}%`, background: sumColor }}
                  />
                </div>
              </div>
            )}

            {/* Time remaining */}
            {dipArb?.endTime && (
              <div>
                <div className="flex justify-between font-jb text-[9px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  <span>Time remaining</span>
                  <span style={{ color: '#f59e0b' }}>{timeRemaining}</span>
                </div>
                <div className="h-px rounded-full" style={{ background: 'var(--border-strong)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-1000"
                    style={{ width: `${progress}%`, background: 'rgba(245,158,11,0.6)' }}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-6 text-center">
            <p className="font-inter text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>No active market</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              Waiting for next rotation…
            </p>
          </div>
        )}

        {/* Signals */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Signals</p>
            <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{dipArb?.signals?.length ?? 0}</p>
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {(dipArb?.signals ?? []).length === 0 ? (
              <p className="font-jb text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>Waiting for signals…</p>
            ) : (
              (dipArb?.signals ?? []).slice(0, 5).map((sig) => (
                <div key={sig.id} className="flex items-center justify-between">
                  <span className="font-jb text-[9px] uppercase w-8" style={{ color: getSignalColor(sig.type) }}>{sig.type}</span>
                  <span className="font-jb text-[9px] w-8 text-center" style={{ color: 'var(--text-muted)' }}>{sig.side}</span>
                  <span className="font-jb text-[9px]" style={{ color: 'var(--text-secondary)' }}>@{sig.price.toFixed(3)}</span>
                  <span className="font-jb text-[9px]" style={{ color: sig.change > 0 ? 'var(--profit)' : 'var(--loss)' }}>
                    {sig.change > 0 ? '+' : ''}{sig.change.toFixed(1)}%
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Performance */}
        <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(91,155,208,0.05)', border: '1px solid rgba(91,155,208,0.12)' }}>
          <div className="flex items-center justify-between mb-1.5">
            <p className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Performance (simulated)</p>
            <p className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{paperStats?.tradeCount ?? 0} trades</p>
          </div>
          <p className="font-jb text-sm font-semibold" style={{ color: (paperStats?.totalNetProfitUsd ?? 0) >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
            {(paperStats?.totalNetProfitUsd ?? 0) >= 0 ? '+' : ''}${(paperStats?.totalNetProfitUsd ?? 0).toFixed(4)}
          </p>
          <p className="font-inter text-[9px] mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            Simulated — no real money moved
          </p>
        </div>

        {/* Config */}
        <details className="s-config">
          <summary className="flex items-center gap-1.5">
            <span className="s-chevron font-jb text-[8px]" style={{ color: 'var(--text-muted)' }}>▶</span>
            <span className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Config</span>
          </summary>
          <div className="mt-2 pl-3 space-y-1.5" style={{ borderLeft: '1px solid var(--border)' }}>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Sum target</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>≤ 0.92</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Coins</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>{Array.from(coins).join(' · ')}</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Min profit</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>$0.05</span></div>
            <div className="s-stat-row"><span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>Poll interval</span><span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>10 s</span></div>
            <p className="font-jb text-[9px] mt-1 italic" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>hardcoded — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
