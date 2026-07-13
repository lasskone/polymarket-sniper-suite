import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import {
  Header,
  BalanceCards,
  PnLPanel,
  OnChainStats,
  ActivityLog,
  ConfigPanel,
  ConnectionStatus,
  DipArbPanel,
  SessionSummary,
  HistoryPage,
  PositionsPage,
  StrategyControls,
  NegRiskArbPanel,
  LogicArbPanel,
  SportsbookArbPanel,
} from './components';

type Page = 'dashboard' | 'history' | 'positions';

function SectionDivider({ label, color }: { label: string; color: 'emerald' | 'amber' | 'slate' }) {
  const lineClass = color === 'emerald'
    ? 'via-emerald-500/20'
    : color === 'amber'
    ? 'via-amber-500/20'
    : 'via-white/10';
  const labelClass = color === 'emerald'
    ? 'text-emerald-400/50'
    : color === 'amber'
    ? 'text-amber-400/50'
    : 'text-white/20';

  return (
    <div className="flex items-center gap-4 my-1">
      <div className={`flex-1 h-px bg-gradient-to-r from-transparent ${lineClass} to-transparent`} />
      <span className={`text-[10px] font-semibold tracking-[0.22em] uppercase ${labelClass}`}>{label}</span>
      <div className={`flex-1 h-px bg-gradient-to-r from-transparent ${lineClass} to-transparent`} />
    </div>
  );
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const { state, config, logs, connected, error, sendCommand } = useWebSocket();
  const isDryRun = config?.dryRun ?? true;

  const handleClosePosition = (tokenId: string, size: number) => {
    sendCommand('closePosition', { tokenId, size });
  };

  const handleToggleStrategy = (strategy: string, enabled: boolean) => {
    sendCommand('toggleStrategy', { strategy, enabled });
  };

  const handleRedeemPosition = (conditionId: string) => {
    sendCommand('redeemPosition', { conditionId });
  };

  const handleToggleDryRun = () => {
    if (isDryRun) {
      const ok = window.confirm(
        '⚠️ WARNING: You are switching to LIVE trading mode.\n\nReal funds will be used. Continue?'
      );
      if (!ok) return;
    }
    sendCommand('toggleDryRun', { enabled: !isDryRun });
  };

  if (currentPage === 'history') {
    return <HistoryPage onBack={() => setCurrentPage('dashboard')} />;
  }

  if (currentPage === 'positions') {
    return (
      <PositionsPage
        onBack={() => setCurrentPage('dashboard')}
        state={state}
        onClosePosition={handleClosePosition}
        onRedeemPosition={handleRedeemPosition}
      />
    );
  }

  return (
    <div className={`min-h-screen text-white ${isDryRun ? 'dry-run-breathing' : 'live-mode-breathing'}`}>
      <ConnectionStatus connected={connected} error={error} />

      <Header
        state={state}
        config={config}
        connected={connected}
        onHistoryClick={() => setCurrentPage('history')}
        onPositionsClick={() => setCurrentPage('positions')}
        onToggleDryRun={handleToggleDryRun}
      />

      <main className="px-4 pt-5 pb-8 space-y-5 max-w-[1800px] mx-auto">

        {/* ── Section 1: Risk-Free Arb ── */}
        <SectionDivider label="Risk-Free Arbitrage" color="emerald" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <DipArbPanel state={state} config={config} />
          <NegRiskArbPanel state={state} />
          <LogicArbPanel state={state} />
        </div>

        {/* ── Section 2: Directional ── */}
        <SectionDivider label="Directional" color="amber" />
        <SportsbookArbPanel state={state} />

        {/* ── Section 3: System ── */}
        <SectionDivider label="System" color="slate" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <PnLPanel state={state} config={config} />
          <SessionSummary state={state} />
          <BalanceCards state={state} />
        </div>

        {/* Controls + on-chain — slim row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StrategyControls config={config} onToggle={handleToggleStrategy} />
          <OnChainStats state={state} />
        </div>

        {/* Activity log — full width */}
        <ActivityLog logs={logs} />

        {/* Advanced config — collapsible */}
        <details className="group">
          <summary className="cursor-pointer flex items-center gap-2 text-[10px] text-white/20 hover:text-white/40 transition-colors py-1 select-none">
            <span className="transition-transform group-open:rotate-90">▶</span>
            Advanced Configuration
          </summary>
          <div className="mt-3">
            <ConfigPanel config={config} />
          </div>
        </details>
      </main>

      <footer className="text-center py-4 border-t border-white/[0.04] text-[10px] text-white/15">
        Polymarket Bot · {connected ? 'Connected' : 'Disconnected'}
      </footer>
    </div>
  );
}

export default App;
