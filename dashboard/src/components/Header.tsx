import { useEffect, useState } from 'react';
import type { BotState, BotConfig } from '../types';

interface HeaderProps {
  state: BotState | null;
  config: BotConfig | null;
  connected: boolean;
  onHistoryClick?: () => void;
  onPositionsClick?: () => void;
  onToggleDryRun?: () => void;
}

export function Header({ state, config, connected, onHistoryClick, onPositionsClick, onToggleDryRun }: HeaderProps) {
  const [runtime, setRuntime] = useState('0s');

  useEffect(() => {
    if (!state?.startTime) return;
    const updateRuntime = () => {
      const diff = Date.now() - state.startTime;
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRuntime(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    updateRuntime();
    const iv = setInterval(updateRuntime, 1000);
    return () => clearInterval(iv);
  }, [state?.startTime]);

  const isDryRun = config?.dryRun ?? true;
  const isPaused = state?.isPaused ?? false;

  const walletAddress = '0xaF98e0638671abD5140Ad981Ff4c01869F3410de';
  const shortWallet = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;

  const usdc  = state?.usdcBalance  ?? 0;
  const usdce = state?.usdcEBalance ?? 0;
  const matic = state?.maticBalance ?? 0;

  const statusColor = !connected ? 'text-red-400' : isPaused ? 'text-yellow-400' : 'text-emerald-400';
  const statusLabel = !connected ? 'OFFLINE' : isPaused ? 'PAUSED' : 'RUNNING';

  return (
    <header className="glass-card border-b border-white/[0.06] px-6 py-3">
      <div className="flex items-center justify-between gap-6">

        {/* Left: Brand + status */}
        <div className="flex items-center gap-5 min-w-0">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500/30 to-indigo-500/30 flex items-center justify-center text-sm border border-white/10">
              🤖
            </div>
            <span className="text-sm font-semibold text-white/90 tracking-tight whitespace-nowrap">
              Polymarket Bot
            </span>
          </div>

          {/* Status pill */}
          <div className={`flex items-center gap-1.5 text-xs font-medium ${statusColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${!connected ? 'bg-red-400' : isPaused ? 'bg-yellow-400' : 'bg-emerald-400 animate-pulse'}`} />
            {statusLabel}
          </div>

          {/* Mode badge */}
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wider border ${
            isDryRun
              ? 'bg-blue-500/10 border-blue-500/25 text-blue-300'
              : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
          }`}>
            {isDryRun ? 'DRY RUN' : 'LIVE'}
          </span>

          {/* Runtime */}
          <span className="text-xs font-mono text-white/30">⏱ {runtime}</span>
        </div>

        {/* Center: balances */}
        <div className="hidden lg:flex items-center gap-5 text-xs font-mono">
          <span className="text-white/25">USDC</span>
          <span className="text-white/70">${usdc.toFixed(2)}</span>
          <span className="text-white/15">│</span>
          <span className="text-white/25">USDCe</span>
          <span className="text-white/70">${usdce.toFixed(2)}</span>
          <span className="text-white/15">│</span>
          <span className="text-white/25">MATIC</span>
          <span className="text-white/70">{matic.toFixed(3)}</span>
        </div>

        {/* Right: wallet + nav */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden xl:block font-mono text-xs text-white/25">{shortWallet}</span>

          <div className="h-4 w-px bg-white/10" />

          <button
            onClick={onPositionsClick}
            className="text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1"
          >
            Positions
          </button>
          <button
            onClick={onHistoryClick}
            className="text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1"
          >
            History
          </button>

          <button
            onClick={onToggleDryRun}
            className={`text-[10px] px-2.5 py-1 rounded-lg border font-medium transition-all ${
              isDryRun
                ? 'border-emerald-500/25 text-emerald-300/70 hover:bg-emerald-500/10'
                : 'border-red-500/25 text-red-300/70 hover:bg-red-500/10'
            }`}
          >
            Switch to {isDryRun ? 'LIVE' : 'DRY RUN'}
          </button>
        </div>
      </div>
    </header>
  );
}
