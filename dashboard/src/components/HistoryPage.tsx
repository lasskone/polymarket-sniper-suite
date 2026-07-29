import { useState, useEffect, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaperTrade {
  id: string;
  module: string;
  market_label: string;
  net_profit_usd: number | string | null;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  entry_price: number | string | null;
  shares: number | string;
}

interface TradeStats {
  totalCount: number;
  totalSettledPnl: number;
  openCount: number;
  byModule: Record<string, { count: number; settledPnl: number; openCount: number }>;
}

interface TradesResponse {
  trades: PaperTrade[];
  total: number;
  stats: TradeStats;
}

interface HistoryPageProps {
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODULES = ['dip-arb', 'negrisk-arb', 'logic-arb', 'sportsbook-arb'] as const;
const STATUSES = ['settled', 'open', 'won', 'lost'] as const;

const MODULE_LABEL: Record<string, string> = {
  'dip-arb':        'Dip Arb',
  'negrisk-arb':    'NegRisk',
  'logic-arb':      'Logic Arb',
  'sportsbook-arb': 'Sportsbook',
};

// ---------------------------------------------------------------------------
// Tiny style helpers
// ---------------------------------------------------------------------------

function modulePill(mod: string) {
  const isSbook = mod === 'sportsbook-arb';
  return {
    background: isSbook ? 'rgba(217,150,47,0.1)'  : 'rgba(91,155,208,0.1)',
    border:     `1px solid ${isSbook ? 'rgba(217,150,47,0.3)' : 'rgba(91,155,208,0.3)'}`,
    color:      isSbook ? '#d9962f' : 'var(--riskfree)',
  };
}

function statusPill(status: string) {
  switch (status) {
    case 'won':
    case 'settled': return { background: 'rgba(74,222,128,0.08)',  border: '1px solid rgba(74,222,128,0.2)',  color: 'var(--profit)'   };
    case 'lost':    return { background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--loss)'     };
    case 'open':    return { background: 'rgba(91,155,208,0.1)',   border: '1px solid rgba(91,155,208,0.3)',  color: 'var(--riskfree)' };
    default:        return { background: 'rgba(90,98,112,0.12)',   border: '1px solid rgba(90,98,112,0.25)',  color: 'var(--text-muted)' };
  }
}

function pnlColor(val: number | null) {
  if (val == null) return 'var(--text-muted)';
  return val >= 0 ? 'var(--profit)' : 'var(--loss)';
}

function formatPnl(val: number | string | null): string {
  if (val == null) return '—';
  const n = Number(val);
  if (isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(4);
}

function formatDt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Pill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="font-jb text-[9px] uppercase tracking-wider px-2.5 py-1 rounded-full transition-all"
      style={{
        background:  active ? 'rgba(255,255,255,0.1)' : 'transparent',
        border:      `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`,
        color:       active ? 'var(--text-primary)'  : 'var(--text-muted)',
        cursor:      'pointer',
      }}
    >
      {label}
    </button>
  );
}

function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="text-right">
      <p className="font-jb text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="font-jb text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HistoryPage({ onBack }: HistoryPageProps) {
  const [data, setData]       = useState<TradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [modFilter, setModFilter]    = useState<string>('all');
  const [statFilter, setStatFilter]  = useState<string>('all');
  const [sortCol, setSortCol]        = useState<'opened_at' | 'net_profit_usd'>('opened_at');
  const [sortDir, setSortDir]        = useState<'desc' | 'asc'>('desc');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/trades');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: TradesResponse = await res.json();
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Client-side filtering + sorting
  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data.trades;
    if (modFilter  !== 'all') rows = rows.filter(r => r.module === modFilter);
    if (statFilter !== 'all') rows = rows.filter(r => r.status === statFilter);
    rows = [...rows].sort((a, b) => {
      if (sortCol === 'opened_at') {
        const diff = new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime();
        return sortDir === 'desc' ? -diff : diff;
      }
      const av = a.net_profit_usd == null ? -Infinity : Number(a.net_profit_usd);
      const bv = b.net_profit_usd == null ? -Infinity : Number(b.net_profit_usd);
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return rows;
  }, [data, modFilter, statFilter, sortCol, sortDir]);

  // Stats over filtered view
  const filteredStats = useMemo(() => {
    let settledPnl = 0;
    let open = 0;
    for (const t of filtered) {
      if (t.status === 'open') { open++; continue; }
      if (t.net_profit_usd != null) settledPnl += Number(t.net_profit_usd);
    }
    return { count: filtered.length, settledPnl, open };
  }, [filtered]);

  function toggleSort(col: 'opened_at' | 'net_profit_usd') {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  const SortArrow = ({ col }: { col: 'opened_at' | 'net_profit_usd' }) =>
    sortCol === col
      ? <span style={{ color: 'var(--text-secondary)' }}> {sortDir === 'desc' ? '↓' : '↑'}</span>
      : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-0)', color: 'var(--text-primary)' }}>

      {/* ── Topbar ── */}
      <div className="s-topbar" style={{ marginLeft: 0 }}>
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="font-jb text-[11px] px-3 py-1.5 rounded"
            style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            ← Back
          </button>
          <div>
            <h1 className="font-space text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Trade History</h1>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>All paper trades across all modules</p>
          </div>
        </div>

        {data && (
          <div className="flex items-center gap-6">
            <StatCell
              label="Showing"
              value={String(filteredStats.count)}
              sub={`of ${data.total} total`}
            />
            <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
            <StatCell
              label="Settled P&L"
              value={(filteredStats.settledPnl >= 0 ? '+' : '') + '$' + Math.abs(filteredStats.settledPnl).toFixed(4)}
              sub={`${filteredStats.open} open`}
            />
            <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
            <button
              onClick={load}
              className="font-jb text-[10px] px-2.5 py-1 rounded"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {/* ── Content ── */}
      <main className="px-6 py-6 space-y-4">

        {/* ── Filter bar ── */}
        <div className="s-card px-5 py-3">
          <div className="flex flex-wrap items-center gap-4">
            {/* Module filter */}
            <div className="flex items-center gap-1.5">
              <span className="font-jb text-[9px] uppercase tracking-wider pr-1" style={{ color: 'var(--text-muted)' }}>Module</span>
              <Pill label="All" active={modFilter === 'all'} onClick={() => setModFilter('all')} />
              {MODULES.map(m => (
                <Pill key={m} label={MODULE_LABEL[m]} active={modFilter === m} onClick={() => setModFilter(m)} />
              ))}
            </div>

            <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

            {/* Status filter */}
            <div className="flex items-center gap-1.5">
              <span className="font-jb text-[9px] uppercase tracking-wider pr-1" style={{ color: 'var(--text-muted)' }}>Status</span>
              <Pill label="All" active={statFilter === 'all'} onClick={() => setStatFilter('all')} />
              {STATUSES.map(s => (
                <Pill key={s} label={s} active={statFilter === s} onClick={() => setStatFilter(s)} />
              ))}
            </div>
          </div>
        </div>

        {/* ── Table ── */}
        {loading ? (
          <div className="s-card px-5 py-12 text-center">
            <p className="font-jb text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading trades…</p>
          </div>
        ) : error ? (
          <div className="s-card px-5 py-12 text-center space-y-3">
            <p className="font-inter text-[12px]" style={{ color: 'var(--loss)' }}>{error}</p>
            <button
              onClick={load}
              className="font-jb text-[10px] px-3 py-1.5 rounded"
              style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="s-card px-5 py-12 text-center">
            <p className="font-jb text-[11px]" style={{ color: 'var(--text-muted)' }}>No trades match the current filters.</p>
          </div>
        ) : (
          <div className="s-card" style={{ overflow: 'hidden' }}>

            {/* Table header */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr 100px 80px 60px 130px 130px',
                padding: '10px 16px',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {[
                { label: 'Module',       col: null,              align: 'left'  },
                { label: 'Market / Pair',col: null,              align: 'left'  },
                { label: 'Net P&L',      col: 'net_profit_usd' as const, align: 'right' },
                { label: 'Status',       col: null,              align: 'left'  },
                { label: 'Shares',       col: null,              align: 'right' },
                { label: 'Opened',       col: 'opened_at' as const,      align: 'left'  },
                { label: 'Resolved',     col: null,              align: 'left'  },
              ].map(({ label, col, align }) => (
                <div
                  key={label}
                  onClick={col ? () => toggleSort(col) : undefined}
                  className="font-jb text-[9px] uppercase tracking-wider select-none"
                  style={{
                    color:    col ? 'var(--text-secondary)' : 'var(--text-muted)',
                    textAlign: align as React.CSSProperties['textAlign'],
                    cursor:   col ? 'pointer' : 'default',
                  }}
                >
                  {label}{col ? <SortArrow col={col} /> : null}
                </div>
              ))}
            </div>

            {/* Scrollable body */}
            <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
              {filtered.map((trade, i) => {
                const pnl    = trade.net_profit_usd != null ? Number(trade.net_profit_usd) : null;
                const mStyle = modulePill(trade.module);
                const sStyle = statusPill(trade.status);
                return (
                  <div
                    key={trade.id}
                    style={{
                      display:     'grid',
                      gridTemplateColumns: '110px 1fr 100px 80px 60px 130px 130px',
                      padding:     '9px 16px',
                      borderBottom: '1px solid var(--border)',
                      background:  i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                      alignItems:  'center',
                    }}
                  >
                    {/* Module */}
                    <div>
                      <span
                        className="font-jb text-[9px] px-1.5 py-0.5 rounded"
                        style={mStyle}
                      >
                        {MODULE_LABEL[trade.module] ?? trade.module}
                      </span>
                    </div>

                    {/* Label */}
                    <div
                      className="font-inter text-[11px] pr-4 truncate"
                      style={{ color: 'var(--text-secondary)' }}
                      title={trade.market_label}
                    >
                      {trade.market_label}
                    </div>

                    {/* P&L */}
                    <div
                      className="font-jb text-[11px] text-right"
                      style={{ color: pnlColor(pnl) }}
                    >
                      {formatPnl(trade.net_profit_usd)}
                    </div>

                    {/* Status */}
                    <div>
                      <span
                        className="font-jb text-[9px] px-1.5 py-0.5 rounded"
                        style={sStyle}
                      >
                        {trade.status}
                      </span>
                    </div>

                    {/* Shares */}
                    <div
                      className="font-jb text-[11px] text-right"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {Number(trade.shares).toFixed(0)}
                    </div>

                    {/* Opened */}
                    <div
                      className="font-jb text-[10px]"
                      style={{ color: 'var(--text-muted)' }}
                      title={formatDt(trade.opened_at)}
                    >
                      {formatShort(trade.opened_at)}
                    </div>

                    {/* Resolved */}
                    <div
                      className="font-jb text-[10px]"
                      style={{ color: trade.resolved_at ? 'var(--text-muted)' : 'rgba(90,98,112,0.5)' }}
                      title={trade.resolved_at ? formatDt(trade.resolved_at) : undefined}
                    >
                      {trade.resolved_at ? formatShort(trade.resolved_at) : '—'}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer count */}
            <div
              className="px-4 py-2 font-jb text-[9px] uppercase tracking-wider text-right"
              style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.01)' }}
            >
              {filtered.length} row{filtered.length !== 1 ? 's' : ''}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
