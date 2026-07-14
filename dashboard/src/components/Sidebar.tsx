import { useEffect, useState } from 'react';
import type { BotState, BotConfig } from '../types';

interface SidebarProps {
  state: BotState | null;
  config: BotConfig | null;
  connected: boolean;
  activePage: string;
  activeNav: string;
  onNavigate: (page: string) => void;
  onNavSelect: (nav: string) => void;
  onToggleDryRun: () => void;
}

function ReticleMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="8" stroke="var(--reticle)" strokeWidth="1.5" />
      <line x1="2"  y1="11" x2="7"  y2="11" stroke="var(--reticle)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="15" y1="11" x2="20" y2="11" stroke="var(--reticle)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="2"  x2="11" y2="7"  stroke="var(--reticle)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="15" x2="11" y2="20" stroke="var(--reticle)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="11" cy="11" r="2" fill="var(--reticle)" />
    </svg>
  );
}

const WALLET = '0xaF98e0638671abD5140Ad981Ff4c01869F3410de';
const SHORT_WALLET = `${WALLET.slice(0, 6)}…${WALLET.slice(-4)}`;

export function Sidebar({
  state, config, connected, activePage, activeNav,
  onNavigate, onNavSelect, onToggleDryRun,
}: SidebarProps) {
  const [runtime, setRuntime] = useState('0s');

  useEffect(() => {
    if (!state?.startTime) return;
    const update = () => {
      const diff = Date.now() - state.startTime;
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRuntime(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [state?.startTime]);

  const isDryRun = config?.dryRun ?? true;
  const isPaused = state?.isPaused ?? false;

  const statusDot = !connected ? 'var(--loss)' : isPaused ? '#f59e0b' : 'var(--reticle)';
  const statusLabel = !connected ? 'OFFLINE' : isPaused ? 'PAUSED' : isDryRun ? 'DRY RUN' : 'LIVE';

  const dipArbLive   = !!(state?.dipArb?.status === 'active' || state?.dipArb?.marketName);
  const negRiskLive  = state?.negRiskArb?.status === 'scanning';
  const logicArbLive = state?.logicArb?.status === 'scanning';
  const sbArbLive    = state?.sportsbookArb?.status === 'scanning';

  function NavItem({
    id, label, page, isLive,
  }: { id: string; label: string; page?: string; isLive?: boolean }) {
    const isActive = page ? activePage === page : activeNav === id;
    const handleClick = () => { page ? onNavigate(page) : onNavSelect(id); };
    return (
      <button
        onClick={handleClick}
        className={`s-nav-item${isActive ? ' s-nav-item-active' : ''}`}
      >
        <span>{label}</span>
        {isLive !== undefined && (
          <span
            className="font-jb text-[9px]"
            style={{ color: isLive ? 'var(--reticle)' : 'var(--text-muted)' }}
          >
            {isLive ? '● LIVE' : '○'}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="s-sidebar">
      {/* ── Logo ── */}
      <div
        className="flex items-center gap-3 px-4 py-5"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <ReticleMark />
        <div>
          <div
            className="font-space font-bold text-[11px] tracking-[0.14em] uppercase"
            style={{ color: 'var(--text-primary)' }}
          >
            SNIPER SUITE
          </div>
          <div
            className="font-jb text-[9px] tracking-wider mt-0.5"
            style={{ color: 'var(--text-muted)' }}
          >
            Polymarket
          </div>
        </div>
      </div>

      {/* ── Status pill ── */}
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse"
          style={{ background: statusDot }}
        />
        <span className="font-jb text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {statusLabel}
        </span>
        <span className="font-jb text-[9px] ml-auto" style={{ color: 'var(--text-muted)' }}>
          {runtime}
        </span>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 py-1">
        <div className="s-nav-section-label">Overview</div>
        <NavItem id="command-center" label="Command center" page="dashboard" />

        <div className="s-nav-section-label" style={{ marginTop: 8 }}>Risk-free arbitrage</div>
        <NavItem id="dipArb"       label="DipArb"       isLive={dipArbLive} />
        <NavItem id="negRiskArb"   label="NegRisk arb"  isLive={negRiskLive} />
        <NavItem id="logicArb"     label="Logic arb"    isLive={logicArbLive} />

        <div className="s-nav-section-label" style={{ marginTop: 8 }}>Directional</div>
        <NavItem id="sportsbookArb" label="Sportsbook arb" isLive={sbArbLive} />

        <div className="s-nav-section-label" style={{ marginTop: 8 }}>System</div>
        <NavItem id="pnl"           label="P&L & balances" />
        <NavItem id="activityLog"   label="Activity log" />
        <NavItem id="configuration" label="Configuration" />

        <div className="mx-4 my-2" style={{ height: 1, background: 'var(--border)' }} />

        <NavItem id="positions" label="Positions" page="positions" />
        <NavItem id="history"   label="History"   page="history" />
      </nav>

      {/* ── Footer ── */}
      <div className="px-4 py-4" style={{ borderTop: '1px solid var(--border)' }}>
        <p className="font-jb text-[10px] mb-3 truncate" style={{ color: 'var(--text-muted)' }}>
          {SHORT_WALLET}
        </p>
        <button
          onClick={onToggleDryRun}
          className="w-full font-jb text-[10px] px-3 py-1.5 rounded-full transition-colors hover:bg-white/5"
          style={{ border: '1px solid var(--reticle)', color: 'var(--reticle)' }}
        >
          Switch to {isDryRun ? 'LIVE' : 'DRY RUN'}
        </button>
      </div>
    </div>
  );
}
