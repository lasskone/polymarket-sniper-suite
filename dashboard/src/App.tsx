import { useState, useMemo } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { usePaperStats } from './hooks/usePaperStats';
import {
  Sidebar,
  ConnectionStatus,
  DipArbPanel,
  NegRiskArbPanel,
  LogicArbPanel,
  SportsbookArbPanel,
  PnLPanel,
  ActivityLog,
  StrategyControls,
  ConfigPanel,
  HistoryPage,
  PositionsPage,
} from './components';

type Page = 'dashboard' | 'history' | 'positions';

function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <div className="s-section-label">
      <span className="s-section-label-text" style={{ color }}>
        {label}
      </span>
      <div className="s-section-label-line" style={{ background: `${color}20` }} />
    </div>
  );
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [activeNav, setActiveNav]     = useState('command-center');
  const { state, config, logs, connected, error, sendCommand } = useWebSocket();
  const isDryRun = config?.dryRun ?? true;

  // Refresh paper stats whenever new SIGNAL log entries arrive.
  const signalCount = useMemo(
    () => logs.filter((l) => l.level === 'SIGNAL').length,
    [logs],
  );
  const paperStats = usePaperStats(signalCount);

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
        '⚠️ WARNING: Switching to LIVE trading mode.\n\nReal funds will be used. Continue?'
      );
      if (!ok) return;
    }
    sendCommand('toggleDryRun', { enabled: !isDryRun });
  };

  // History / Positions are full-page (no sidebar)
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

  // Count active modules for topbar
  const activeModules = [
    config?.dipArb?.enabled,
    config?.negRiskArb?.enabled,
    config?.logicArb?.enabled,
    config?.sportsbookArb?.enabled,
  ].filter(Boolean).length;

  const usdc  = state?.usdcBalance  ?? 0;
  const matic = state?.maticBalance ?? 0;

  return (
    <div className={`min-h-screen ${isDryRun ? 'dry-run-breathing' : 'live-mode-breathing'}`}>
      <ConnectionStatus connected={connected} error={error} />

      {/* Sidebar */}
      <Sidebar
        state={state}
        config={config}
        connected={connected}
        activePage={currentPage}
        activeNav={activeNav}
        onNavigate={(page) => setCurrentPage(page as Page)}
        onNavSelect={setActiveNav}
        onToggleDryRun={handleToggleDryRun}
      />

      {/* Main area — offset by sidebar width */}
      <div className="flex flex-col" style={{ marginLeft: 250, minHeight: '100vh' }}>

        {/* Topbar */}
        <div className="s-topbar">
          <h1 className="font-space text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Command Center
          </h1>
          <div className="flex items-center gap-5 font-jb text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <span>
              USDC{' '}
              <span style={{ color: 'var(--text-primary)' }}>${usdc.toFixed(2)}</span>
            </span>
            <span style={{ color: 'var(--border-strong)' }}>│</span>
            <span>
              MATIC{' '}
              <span style={{ color: 'var(--text-primary)' }}>{matic.toFixed(3)}</span>
            </span>
            <span style={{ color: 'var(--border-strong)' }}>│</span>
            <span style={{ color: activeModules > 0 ? 'var(--riskfree)' : 'var(--text-muted)' }}>
              {activeModules}/4 modules active
            </span>
          </div>
        </div>

        {/* Content */}
        <main className="flex-1 px-6 py-6 space-y-8">

          {/* ── Risk-free arbitrage ── */}
          <section>
            <SectionLabel label="Risk-free arbitrage" color="var(--riskfree)" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <DipArbPanel state={state} config={config} paperStats={paperStats.byModule['dip-arb']} />
              <NegRiskArbPanel state={state} paperStats={paperStats.byModule['negrisk-arb']} />
              <LogicArbPanel state={state} paperStats={paperStats.byModule['logic-arb']} />
            </div>
          </section>

          {/* ── Directional ── */}
          <section>
            <SectionLabel label="Directional" color="var(--directional)" />
            <SportsbookArbPanel state={state} />
          </section>

          {/* ── System ── */}
          <section>
            <SectionLabel label="System" color="var(--text-muted)" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <PnLPanel state={state} config={config} />
              <ActivityLog logs={logs} />
            </div>
          </section>

          {/* ── Advanced (collapsible) ── */}
          <details className="s-config">
            <summary className="flex items-center gap-2 py-1 cursor-pointer select-none">
              <span className="s-chevron font-jb text-[8px]" style={{ color: 'var(--text-muted)' }}>▶</span>
              <span className="font-jb text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Advanced configuration
              </span>
            </summary>
            <div className="mt-4 space-y-4">
              <StrategyControls config={config} onToggle={handleToggleStrategy} />
              <ConfigPanel config={config} />
            </div>
          </details>
        </main>

        {/* Footer */}
        <footer className="px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="font-jb text-[9px] text-center" style={{ color: 'var(--text-muted)' }}>
            Polymarket Bot · {connected ? 'Connected' : 'Disconnected'}
          </p>
        </footer>
      </div>
    </div>
  );
}

export default App;
