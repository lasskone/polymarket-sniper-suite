import { useEffect, useState } from 'react';
import type { BotState, BotConfig, DipArbSignal } from '../types';
import { Sparkline } from './Sparkline';

interface DipArbPanelProps {
  state: BotState | null;
  config?: BotConfig | null;
}

const MAX_PRICE_HISTORY = 30;

export function DipArbPanel({ state, config }: DipArbPanelProps) {
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
  const sumOk = sum > 0 && sum <= 0.92;
  const sumClose = sum > 0.92 && sum <= 0.98;

  const coins = config?.dipArb?.coins ?? ['ETH', 'BTC', 'SOL'];

  const getSignalColor = (type: DipArbSignal['type']) => {
    if (type === 'dip')  return 'text-red-400';
    if (type === 'surge') return 'text-emerald-400';
    if (type === 'leg1') return 'text-blue-400';
    return 'text-purple-400';
  };

  return (
    <div className="glass-card card-emerald rounded-2xl overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-emerald-400/60 mb-1">
            Risk-Free · DipArb
          </p>
          <h2 className="text-base font-semibold text-white/90">DipArb Monitor</h2>
        </div>
        {isActive ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold animate-pulse">
            ● LIVE
          </span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/30 font-semibold">
            IDLE
          </span>
        )}
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col gap-5">
        {/* Live prices or idle state */}
        {isActive ? (
          <>
            {/* Market name */}
            <p className="text-xs text-white/50 truncate -mt-1" title={dipArb?.marketName ?? ''}>
              {dipArb?.marketName}
            </p>

            {/* Price trio */}
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'UP', value: dipArb?.upPrice ?? 0, color: 'text-emerald-400', history: upPriceHistory, hcolor: 'green' as const },
                { label: 'DOWN', value: dipArb?.downPrice ?? 0, color: 'text-red-400', history: downPriceHistory, hcolor: 'red' as const },
                { label: 'SUM', value: sum, color: sumOk ? 'text-emerald-400' : sumClose ? 'text-yellow-400' : 'text-white/60' },
              ].map(({ label, value, color, history, hcolor }) => (
                <div key={label}>
                  <p className="text-[10px] text-white/30 mb-1 font-medium">{label}</p>
                  <p className={`text-xl font-bold font-mono ${color}`}>
                    {value > 0 ? value.toFixed(3) : '—'}
                  </p>
                  {history && history.length > 1 && (
                    <div className="mt-1.5 flex justify-center">
                      <Sparkline data={history} width={56} height={16} color={hcolor} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Sum status */}
            {sum > 0 && (
              <div>
                <div className="flex justify-between text-[10px] text-white/30 mb-1.5">
                  <span>Sum → target ≤ 0.92</span>
                  <span className={sumOk ? 'text-emerald-400' : sumClose ? 'text-yellow-400' : 'text-white/50'}>
                    {sumOk ? '🎯 Opportunity' : sumClose ? 'Close' : 'Normal'}
                  </span>
                </div>
                <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${sumOk ? 'bg-emerald-500' : sumClose ? 'bg-yellow-500' : 'bg-white/20'}`}
                    style={{ width: `${Math.min(100, (sum / 1.05) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Time remaining */}
            {dipArb?.endTime && (
              <div>
                <div className="flex justify-between text-[10px] text-white/30 mb-1.5">
                  <span>Time remaining</span>
                  <span className="font-mono text-yellow-400/80">{timeRemaining}</span>
                </div>
                <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-yellow-500/50 transition-all duration-1000"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
            <p className="text-2xl mb-2 opacity-30">🔍</p>
            <p className="text-xs text-white/30">No active market</p>
            <p className="text-[10px] text-white/20 mt-0.5">Waiting for next rotation…</p>
          </div>
        )}

        <div className="inner-divider" />

        {/* Recent signals */}
        <div>
          <div className="flex justify-between items-center mb-2.5">
            <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-white/30">Signals</p>
            <p className="text-[10px] text-white/20">{dipArb?.signals?.length ?? 0}</p>
          </div>
          <div className="space-y-1.5 max-h-28 overflow-y-auto">
            {(dipArb?.signals ?? []).length === 0 ? (
              <p className="text-[11px] text-white/20 text-center py-3">Waiting for signals…</p>
            ) : (
              (dipArb?.signals ?? []).slice(0, 5).map((sig) => (
                <div key={sig.id} className="flex items-center justify-between text-xs">
                  <span className={`font-semibold uppercase text-[10px] w-10 ${getSignalColor(sig.type)}`}>{sig.type}</span>
                  <span className="text-white/40 w-8 text-center">{sig.side}</span>
                  <span className="font-mono text-white/50">@{sig.price.toFixed(3)}</span>
                  <span className={`font-mono text-[10px] ${sig.change > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {sig.change > 0 ? '+' : ''}{sig.change.toFixed(1)}%
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
            <div className="stat-row">
              <span className="stat-label">Sum target</span>
              <span className="stat-value text-xs">≤ 0.92</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Coins</span>
              <span className="stat-value text-xs">{Array.from(coins).join(' · ')}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Min profit</span>
              <span className="stat-value text-xs">$0.05</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Poll interval</span>
              <span className="stat-value text-xs">10 s</span>
            </div>
            <p className="text-[9px] text-white/15 mt-1.5 italic">hardcoded in service — not adjustable from dashboard</p>
          </div>
        </details>
      </div>
    </div>
  );
}
