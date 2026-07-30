import { useState, useEffect, useCallback } from 'react';
import type { BotConfig, BotState } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PairRow {
  id: string;
  market_a_slug: string;
  market_b_slug: string;
  market_a_condition_id: string;
  market_b_condition_id: string;
  relationship: string;
  notes: string | null;
  active: boolean;
  live_eligible: boolean;
  created_at: string;
}

interface SuggestionRow {
  id: string;
  market_a_slug: string;
  market_b_slug: string;
  market_a_question: string;
  market_b_question: string;
  market_a_condition_id: string;
  market_b_condition_id: string;
  relationship: string;
  confidence: number;
  reasoning: string;
  status: string;
  created_at: string;
}

type Relationship = 'a_implies_b' | 'mutually_exclusive';

interface TradeLeg {
  token:       'YES' | 'NO';
  action:      string;      // e.g. "Buy NO on Market A"
  marketSlug:  string;
  fillPrice:   number;
  notionalUsd: number;
}

interface DetailedTrade {
  id:               string;
  opened_at:        string;
  market_pair_label: string;
  relationship:     Relationship;
  priceA:           number;
  priceB:           number;
  legA:             TradeLeg;
  legB:             TradeLeg;
  totalInvestedUsd: number;
  deviation:        number;
  deviationPct:     number;
  feeRate:          number;
  netProfitUsd:     number;
  shares:           number;
  trading_mode?:    string;
}

interface PairSummary {
  marketPairLabel: string;
  count:           number;
  relationship:    string;
  avgDeviationPct: number;
  avgInvestedUsd:  number;
  avgProfitUsd:    number;
  totalProfitUsd:  number;
}

interface DetailedTotals {
  count:            number;
  totalProfitUsd:   number;
  totalInvestedUsd: number;
  avgDeviationPct:  number;
  avgProfitUsd:     number;
}

type SummarySortCol = 'count' | 'avgDeviationPct' | 'avgInvestedUsd' | 'avgProfitUsd' | 'totalProfitUsd';

interface ArbConfig {
  cooldownMs: number;
  minNetProfitUSD: number;
  deadPairNullThreshold: number;
  deadPairClosedThreshold: number;
  liveEnabled: boolean;
  positionSizePct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REL_LABELS: Record<string, string> = {
  a_implies_b:      'A → B',
  mutually_exclusive: 'MUTEX',
};

function relLabel(rel: string) {
  return REL_LABELS[rel] ?? rel.toUpperCase();
}

function polyLink(slug: string) {
  return `https://polymarket.com/event/${slug}`;
}

function fmt(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function pnlColor(v: number | null) {
  if (v == null) return 'var(--text-muted)';
  return v >= 0 ? 'var(--profit)' : 'var(--loss)';
}

// ---------------------------------------------------------------------------
// Pair Discovery card (moved from ConfigPanel)
// ---------------------------------------------------------------------------

function PairDiscoveryCard({ config }: { config: BotConfig }) {
  const pd = config.pairDiscovery ?? { enabled: false, intervalHours: 6 };

  const [enabled, setEnabled]             = useState(pd.enabled);
  const [intervalHours, setIntervalHours] = useState(String(pd.intervalHours));
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [saved, setSaved]                 = useState(false);

  const remoteEnabled  = pd.enabled;
  const remoteInterval = String(pd.intervalHours);
  if (!saving && remoteEnabled !== enabled && remoteInterval === intervalHours) {
    setEnabled(remoteEnabled);
  }

  async function put(patch: { enabled?: boolean; interval_hours?: number }) {
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch('/api/config/pair-discovery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Unknown error');
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="s-card">
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Pair Discovery
            </h3>
            <p className="font-inter text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              AI-powered correlated market pair scanning
            </p>
          </div>
          <span className="font-jb text-[9px] px-2 py-0.5 rounded-full" style={{
            background: enabled ? 'rgba(74,222,128,0.1)' : 'rgba(120,120,120,0.08)',
            border: `1px solid ${enabled ? 'rgba(74,222,128,0.25)' : 'rgba(120,120,120,0.2)'}`,
            color: enabled ? 'var(--profit)' : 'var(--text-muted)',
          }}>
            {enabled ? 'SCANNING' : 'IDLE'}
          </span>
        </div>
      </div>
      <div className="px-5 py-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-inter text-[12px]" style={{ color: 'var(--text-secondary)' }}>Enable scanning</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Writes to correlated_pair_suggestions — approve from the Suggestions table below
            </p>
          </div>
          <button
            onClick={() => { const n = !enabled; setEnabled(n); put({ enabled: n }); }}
            disabled={saving}
            className="relative inline-flex items-center rounded-full transition-colors duration-200 focus:outline-none"
            style={{
              width: 40, height: 22,
              background: enabled ? 'var(--profit)' : 'var(--border-strong)',
              opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          >
            <span style={{
              display: 'block', width: 16, height: 16, borderRadius: '50%',
              background: 'white',
              transform: enabled ? 'translateX(20px)' : 'translateX(3px)',
              transition: 'transform 0.2s',
            }} />
          </button>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-inter text-[12px]" style={{ color: 'var(--text-secondary)' }}>Scan interval (hours)</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Time between successive discovery runs
            </p>
          </div>
          <input
            type="number" min="0.5" step="0.5" value={intervalHours}
            onChange={(e) => setIntervalHours(e.target.value)}
            onBlur={() => {
              const val = parseFloat(intervalHours);
              if (isNaN(val) || val <= 0) { setError('Interval must be positive'); return; }
              setError(null); put({ interval_hours: val });
            }}
            disabled={saving}
            className="font-jb text-[12px] text-right rounded px-2 py-1"
            style={{ width: 72, background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', opacity: saving ? 0.6 : 1 }}
          />
        </div>
        {error && <p className="font-inter text-[10px]" style={{ color: 'var(--loss)' }}>{error}</p>}
        {saved && !error && <p className="font-inter text-[10px]" style={{ color: 'var(--profit)' }}>Saved — takes effect within 2 minutes</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmLiveModal — shown before enabling live trading master switch
// ---------------------------------------------------------------------------

interface ConfirmLiveModalProps {
  onConfirm: () => void;
  onCancel:  () => void;
}

function ConfirmLiveModal({ onConfirm, onCancel }: ConfirmLiveModalProps) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid rgba(239,68,68,0.4)',
        borderRadius: 12, padding: '28px 32px', maxWidth: 440, width: '90%',
      }}>
        <h2 className="font-space text-base font-semibold mb-2" style={{ color: '#ef4444' }}>
          Enable Live Trading — Logic Arb
        </h2>
        <p className="font-inter text-[12px] mb-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          This enables real-money execution for Logic Arb pairs marked as live-eligible.
          Orders will be placed on the Polymarket CLOB using your wallet.
        </p>
        <ul className="font-inter text-[11px] mb-5 space-y-1" style={{ color: 'var(--text-muted)' }}>
          <li>Both legs must fill within 10 s or leg 1 is automatically sold</li>
          <li>All three gates must be active: TRADING_MODE=live + this toggle + per-pair toggle</li>
          <li>Start with small position sizes and monitor the Activity Log closely</li>
        </ul>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel}
            className="font-jb text-[11px] px-4 py-1.5 rounded"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm}
            className="font-jb text-[11px] px-4 py-1.5 rounded"
            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', cursor: 'pointer' }}>
            I understand — Enable Live
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogicArb Config card
// ---------------------------------------------------------------------------

function LogicArbConfigCard() {
  const [cfg, setCfg]           = useState<ArbConfig | null>(null);
  const [cooldownMin, setCooldownMin]           = useState('30');
  const [minProfit, setMinProfit]               = useState('0.05');
  const [nullThreshold, setNullThreshold]       = useState('5');
  const [closedThreshold, setClosedThreshold]   = useState('1');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [saved, setSaved]         = useState(false);
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [liveEnabled, setLiveEnabled]     = useState(false);
  const [posSizePct, setPosSizePct]       = useState('2');

  useEffect(() => {
    fetch('/api/logic-arb/config').then(r => r.json()).then((c: ArbConfig) => {
      setCfg(c);
      setCooldownMin(String(Math.round(c.cooldownMs / 60_000)));
      setMinProfit(String(c.minNetProfitUSD));
      setNullThreshold(String(c.deadPairNullThreshold));
      setClosedThreshold(String(c.deadPairClosedThreshold));
      setLiveEnabled(c.liveEnabled);
      setPosSizePct(String(c.positionSizePct));
    });
  }, []);

  async function save() {
    const cm = parseFloat(cooldownMin);
    const mp = parseFloat(minProfit);
    const nt = parseInt(nullThreshold);
    const ct = parseInt(closedThreshold);
    const ps = parseFloat(posSizePct);
    if (isNaN(cm) || cm <= 0 || isNaN(mp) || mp < 0 || isNaN(nt) || nt <= 0 || isNaN(ct) || ct <= 0 || isNaN(ps) || ps <= 0) {
      setError('All fields must be positive numbers (minNetProfitUSD ≥ 0)');
      return;
    }
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch('/api/logic-arb/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cooldownMs: cm * 60_000,
          minNetProfitUSD: mp,
          deadPairNullThreshold: nt,
          deadPairClosedThreshold: ct,
          liveEnabled,
          positionSizePct: ps,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Save failed');
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        setCfg({ cooldownMs: cm * 60_000, minNetProfitUSD: mp, deadPairNullThreshold: nt, deadPairClosedThreshold: ct, liveEnabled, positionSizePct: ps });
      }
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  const inputStyle = {
    width: 88, background: 'var(--bg-secondary)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)', opacity: saving || !cfg ? 0.6 : 1,
  };

  function Field({ label, sub, value, onChange }: { label: string; sub: string; value: string; onChange: (v: string) => void }) {
    return (
      <div className="flex items-center justify-between gap-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div>
          <p className="font-inter text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</p>
          <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>{sub}</p>
        </div>
        <input
          type="number" value={value} min="0" step="any"
          onChange={(e) => onChange(e.target.value)}
          disabled={saving || !cfg}
          className="font-jb text-[12px] text-right rounded px-2 py-1"
          style={inputStyle}
        />
      </div>
    );
  }

  return (
    <div className="s-card">
      {showLiveModal && (
        <ConfirmLiveModal
          onConfirm={async () => {
            setShowLiveModal(false);
            setLiveEnabled(true);
            await fetch('/api/logic-arb/config', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ liveEnabled: true }),
            });
          }}
          onCancel={() => setShowLiveModal(false)}
        />
      )}
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Logic Arb Config</h3>
        <p className="font-inter text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Stored in bot_config — takes effect within 2 min, no restart needed
        </p>
      </div>
      <div className="px-5 py-3 space-y-0">
        {/* Live Trading toggle */}
        <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <p className="font-inter text-[12px]" style={{ color: liveEnabled ? '#ef4444' : 'var(--text-secondary)' }}>
              Live Trading {liveEnabled && '⚠ ACTIVE'}
            </p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Master switch — requires TRADING_MODE=live + per-pair live_eligible
            </p>
          </div>
          <button
            onClick={() => {
              if (!liveEnabled) {
                setShowLiveModal(true);
              } else {
                setLiveEnabled(false);
                fetch('/api/logic-arb/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ liveEnabled: false }),
                });
              }
            }}
            disabled={saving || !cfg}
            className="relative inline-flex items-center rounded-full transition-colors duration-200 focus:outline-none"
            style={{
              width: 40, height: 22,
              background: liveEnabled ? '#ef4444' : 'var(--border-strong)',
              opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          >
            <span style={{
              display: 'block', width: 16, height: 16, borderRadius: '50%', background: 'white',
              transform: liveEnabled ? 'translateX(20px)' : 'translateX(3px)',
              transition: 'transform 0.2s',
            }} />
          </button>
        </div>
        <Field label="Signal cooldown (min)" sub="Minutes before re-firing same pair signal"
          value={cooldownMin} onChange={setCooldownMin} />
        <Field label="Min net profit (USD)" sub="Minimum P&L after fees to emit a signal"
          value={minProfit} onChange={setMinProfit} />
        <Field label="Position size (%)" sub="% of USDC balance per trade pair"
          value={posSizePct} onChange={setPosSizePct} />
        <Field label="Dead-pair null threshold" sub="Null API responses before auto-deactivation"
          value={nullThreshold} onChange={setNullThreshold} />
        <Field label="Dead-pair closed threshold" sub="Closed-market responses before auto-deactivation"
          value={closedThreshold} onChange={setClosedThreshold} />
      </div>
      <div className="px-5 pb-4 flex items-center gap-3 mt-1">
        <button
          onClick={save}
          disabled={saving || !cfg}
          className="font-jb text-[11px] px-4 py-1.5 rounded"
          style={{
            background: 'var(--reticle)', color: '#000',
            opacity: saving || !cfg ? 0.5 : 1,
            cursor: saving || !cfg ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <span className="font-inter text-[10px]" style={{ color: 'var(--loss)' }}>{error}</span>}
        {saved && !error && <span className="font-inter text-[10px]" style={{ color: 'var(--profit)' }}>Saved</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface LogicArbPageProps {
  onBack: () => void;
  config: BotConfig | null;
  state: BotState | null;
}

export function LogicArbPage({ onBack, config, state }: LogicArbPageProps) {
  const [pairs, setPairs]             = useState<PairRow[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([]);
  const [trades, setTrades]           = useState<DetailedTrade[]>([]);
  const [tradeSummary, setTradeSummary] = useState<PairSummary[]>([]);
  const [tradeTotals, setTradeTotals]   = useState<DetailedTotals | null>(null);
  const [totalTrades, setTotalTrades] = useState(0);
  const [settledPnl, setSettledPnl]   = useState(0);
  const [loading, setLoading]         = useState(true);
  const [actioning, setActioning]     = useState<string | null>(null);
  const [actionErr, setActionErr]     = useState<string | null>(null);
  const [pairsFilter, setPairsFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [suggestionsTab, setSuggestionsTab] = useState<'pending' | 'expired'>('pending');
  const [expiredSuggestions, setExpiredSuggestions] = useState<SuggestionRow[]>([]);
  const [loadingExpired, setLoadingExpired] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<string | null>(null);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [summarySort, setSummarySort] = useState<{ col: SummarySortCol; dir: 'asc' | 'desc' }>({ col: 'count', dir: 'desc' });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [pairsRes, suggestionsRes, tradesRes] = await Promise.all([
        fetch('/api/logic-arb/pairs').then(r => r.json()),
        fetch('/api/logic-arb/suggestions').then(r => r.json()),
        fetch('/api/logic-arb/trades/detailed').then(r => r.json()) as Promise<{
          trades:  DetailedTrade[];
          summary: PairSummary[];
          totals:  DetailedTotals;
        }>,
      ]);
      setPairs(Array.isArray(pairsRes) ? pairsRes : []);
      setSuggestions(Array.isArray(suggestionsRes) ? suggestionsRes : []);
      setTrades(tradesRes.trades ?? []);
      setTradeSummary(tradesRes.summary ?? []);
      setTradeTotals(tradesRes.totals ?? null);
      setTotalTrades(tradesRes.totals?.count ?? 0);
      setSettledPnl(tradesRes.totals?.totalProfitUsd ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchExpired = useCallback(async () => {
    setLoadingExpired(true);
    try {
      const res = await fetch('/api/logic-arb/suggestions?status=expired').then(r => r.json());
      setExpiredSuggestions(Array.isArray(res) ? res : []);
    } finally {
      setLoadingExpired(false);
    }
  }, []);

  const handleSuggestionsTabChange = useCallback((tab: 'pending' | 'expired') => {
    setSuggestionsTab(tab);
    if (tab === 'expired' && expiredSuggestions.length === 0) {
      fetchExpired();
    }
  }, [expiredSuggestions.length, fetchExpired]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleApprove(id: string) {
    setActioning(id); setActionErr(null);
    try {
      const res = await fetch(`/api/pair-suggestions/${id}/approve`, { method: 'PUT' });
      const body = await res.json();
      if (!res.ok) { setActionErr(body.error ?? 'Approve failed'); return; }
      setSuggestions(prev => prev.filter(s => s.id !== id));
      // Refresh pairs list
      const pairsRes = await fetch('/api/logic-arb/pairs').then(r => r.json());
      setPairs(Array.isArray(pairsRes) ? pairsRes : []);
    } catch (e) { setActionErr(String(e)); }
    finally { setActioning(null); }
  }

  async function handleReject(id: string) {
    setActioning(id); setActionErr(null);
    try {
      const res = await fetch(`/api/pair-suggestions/${id}/reject`, { method: 'PUT' });
      if (!res.ok) { const b = await res.json(); setActionErr(b.error ?? 'Reject failed'); return; }
      setSuggestions(prev => prev.filter(s => s.id !== id));
    } catch (e) { setActionErr(String(e)); }
    finally { setActioning(null); }
  }

  const isLive  = state?.logicArb?.status === 'scanning';
  const pTracked = state?.logicArb?.pairsTracked ?? 0;
  const pScanned = state?.logicArb?.pairsScanned ?? 0;

  const filteredPairs = pairs.filter(p =>
    pairsFilter === 'all' ? true : pairsFilter === 'active' ? p.active : !p.active
  );

  // ── Shared sub-components ──────────────────────────────────────────────────

  function SectionHeader({ title, count, extra }: { title: string; count?: number; extra?: React.ReactNode }) {
    return (
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
          {count !== undefined && (
            <span className="font-jb text-[10px] px-1.5 py-0.5 rounded" style={{
              background: 'rgba(120,120,120,0.12)', color: 'var(--text-muted)',
            }}>{count}</span>
          )}
        </div>
        {extra}
      </div>
    );
  }

  function TH({ children, right }: { children: React.ReactNode; right?: boolean }) {
    return (
      <div className="font-jb text-[9px] uppercase tracking-wider py-2 px-3" style={{
        color: 'var(--text-muted)', textAlign: right ? 'right' : 'left',
      }}>{children}</div>
    );
  }

  function TD({ children, right, style }: { children: React.ReactNode; right?: boolean; style?: React.CSSProperties }) {
    return (
      <div className="font-inter text-[11px] py-2 px-3 truncate" style={{
        color: 'var(--text-secondary)', textAlign: right ? 'right' : 'left', ...style,
      }}>{children}</div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-4 px-6 py-4" style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10 }}>
        <button
          onClick={onBack}
          className="font-jb text-[11px] px-3 py-1.5 rounded"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          ← Back
        </button>
        <h1 className="font-space text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Logic Arb</h1>
        <span className="font-jb text-[9px] px-2 py-0.5 rounded-full" style={{
          background: isLive ? 'rgba(74,222,128,0.1)' : 'rgba(120,120,120,0.08)',
          border: `1px solid ${isLive ? 'rgba(74,222,128,0.25)' : 'rgba(120,120,120,0.2)'}`,
          color: isLive ? 'var(--profit)' : 'var(--text-muted)',
        }}>
          {isLive ? '● SCANNING' : '○ IDLE'}
        </span>

        {/* live counters */}
        <div className="flex items-center gap-4 ml-auto font-jb text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          <span>Tracked <span style={{ color: 'var(--text-primary)' }}>{pTracked}</span></span>
          <span style={{ color: 'var(--border-strong)' }}>│</span>
          <span>Scanned <span style={{ color: 'var(--text-primary)' }}>{pScanned}</span></span>
          <span style={{ color: 'var(--border-strong)' }}>│</span>
          <span>P&L <span style={{ color: settledPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}>${settledPnl.toFixed(2)}</span></span>
          <button
            onClick={fetchAll}
            className="font-jb text-[10px] px-3 py-1 rounded ml-2"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6">

        {/* ── Row 1: Config + Pair Discovery ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <LogicArbConfigCard />
          {config ? <PairDiscoveryCard config={config} /> : (
            <div className="s-card px-5 py-4 flex items-center justify-center">
              <span className="font-inter text-xs" style={{ color: 'var(--text-muted)' }}>Loading config…</span>
            </div>
          )}
        </div>

        {/* ── Section 2: Suggestions ── */}
        <div className="s-card">
          <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <SectionHeader
              title="Suggestions"
              count={suggestionsTab === 'pending' ? suggestions.length : expiredSuggestions.length}
              extra={
                <span className="font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Approve → inserts into tracked pairs · Reject → marks suggestion rejected
                </span>
              }
            />
            {/* Tab chips */}
            <div className="flex gap-2 mt-2">
              {(['pending', 'expired'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => handleSuggestionsTabChange(tab)}
                  className="font-jb text-[10px] px-2.5 py-0.5 rounded-full"
                  style={{
                    background: suggestionsTab === tab ? 'var(--reticle)' : 'rgba(120,120,120,0.1)',
                    color: suggestionsTab === tab ? '#000' : 'var(--text-muted)',
                    border: `1px solid ${suggestionsTab === tab ? 'var(--reticle)' : 'var(--border-strong)'}`,
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
            {actionErr && (
              <p className="font-inter text-[10px] mt-1" style={{ color: 'var(--loss)' }}>{actionErr}</p>
            )}
          </div>

          {suggestionsTab === 'expired' ? (
            loadingExpired ? (
              <p className="px-5 py-6 font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>Loading…</p>
            ) : expiredSuggestions.length === 0 ? (
              <p className="px-5 py-6 font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>No expired suggestions</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 80px 1fr', minWidth: 700, borderBottom: '1px solid var(--border)' }}>
                  <TH>Market A</TH><TH>Market B</TH><TH>Rel</TH><TH right>Conf.</TH><TH>Reasoning</TH>
                </div>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {expiredSuggestions.map((s, i) => (
                    <div key={s.id} style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr 80px 80px 1fr', minWidth: 700,
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      borderBottom: '1px solid var(--border)', alignItems: 'start', opacity: 0.6,
                    }}>
                      <div className="py-2 px-3">
                        <a href={polyLink(s.market_a_slug)} target="_blank" rel="noopener noreferrer"
                          className="font-jb text-[10px] block truncate"
                          style={{ color: 'var(--text-muted)', textDecoration: 'none' }} title={s.market_a_slug}>
                          ↗ {s.market_a_slug}
                        </a>
                        <p className="font-inter text-[10px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{s.market_a_question}</p>
                      </div>
                      <div className="py-2 px-3">
                        <a href={polyLink(s.market_b_slug)} target="_blank" rel="noopener noreferrer"
                          className="font-jb text-[10px] block truncate"
                          style={{ color: 'var(--text-muted)', textDecoration: 'none' }} title={s.market_b_slug}>
                          ↗ {s.market_b_slug}
                        </a>
                        <p className="font-inter text-[10px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{s.market_b_question}</p>
                      </div>
                      <TD>
                        <span className="font-jb text-[10px] px-1.5 py-0.5 rounded" style={{
                          background: 'rgba(120,120,120,0.1)', border: '1px solid rgba(120,120,120,0.2)', color: 'var(--text-muted)',
                        }}>{relLabel(s.relationship)}</span>
                      </TD>
                      <TD right><span style={{ color: 'var(--text-muted)' }}>{(Number(s.confidence) * 100).toFixed(0)}%</span></TD>
                      <TD><span className="line-clamp-2">{s.reasoning}</span></TD>
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : suggestions.length === 0 ? (
            <p className="px-5 py-6 font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              {loading ? 'Loading…' : 'No pending suggestions'}
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 80px 1fr 130px', minWidth: 900, borderBottom: '1px solid var(--border)' }}>
                <TH>Market A</TH>
                <TH>Market B</TH>
                <TH>Rel</TH>
                <TH right>Conf.</TH>
                <TH>Reasoning</TH>
                <TH>Actions</TH>
              </div>
              {/* Rows */}
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {suggestions.map((s, i) => (
                  <div key={s.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 80px 80px 1fr 130px', minWidth: 900,
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                    borderBottom: '1px solid var(--border)',
                    alignItems: 'start',
                  }}>
                    <div className="py-2 px-3">
                      <a href={polyLink(s.market_a_slug)} target="_blank" rel="noopener noreferrer"
                        className="font-jb text-[10px] block truncate"
                        style={{ color: 'var(--riskfree)', textDecoration: 'none' }}
                        title={s.market_a_slug}
                      >
                        ↗ {s.market_a_slug}
                      </a>
                      <p className="font-inter text-[10px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {s.market_a_question}
                      </p>
                    </div>
                    <div className="py-2 px-3">
                      <a href={polyLink(s.market_b_slug)} target="_blank" rel="noopener noreferrer"
                        className="font-jb text-[10px] block truncate"
                        style={{ color: 'var(--riskfree)', textDecoration: 'none' }}
                        title={s.market_b_slug}
                      >
                        ↗ {s.market_b_slug}
                      </a>
                      <p className="font-inter text-[10px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {s.market_b_question}
                      </p>
                    </div>
                    <TD>
                      <span className="font-jb text-[10px] px-1.5 py-0.5 rounded" style={{
                        background: s.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.1)' : 'rgba(91,155,208,0.1)',
                        border: `1px solid ${s.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.2)' : 'rgba(91,155,208,0.2)'}`,
                        color: s.relationship === 'mutually_exclusive' ? '#ef4444' : 'var(--riskfree)',
                      }}>
                        {relLabel(s.relationship)}
                      </span>
                    </TD>
                    <TD right>
                      <span style={{ color: Number(s.confidence) >= 0.8 ? 'var(--profit)' : Number(s.confidence) >= 0.6 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {(Number(s.confidence) * 100).toFixed(0)}%
                      </span>
                    </TD>
                    <div className="py-2 px-3">
                      {expandedReasoning === s.id ? (
                        <p className="font-inter text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          {s.reasoning}
                          <button onClick={() => setExpandedReasoning(null)} className="ml-1" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>▲</button>
                        </p>
                      ) : (
                        <p className="font-inter text-[10px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                          {s.reasoning}
                          {s.reasoning.length > 80 && (
                            <button onClick={() => setExpandedReasoning(s.id)} className="ml-1" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>▼</button>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="py-2 px-3 flex gap-2 items-start">
                      <button
                        onClick={() => handleApprove(s.id)}
                        disabled={actioning === s.id}
                        className="font-jb text-[10px] px-2.5 py-1 rounded"
                        style={{
                          background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)',
                          color: 'var(--profit)', cursor: actioning === s.id ? 'not-allowed' : 'pointer',
                          opacity: actioning === s.id ? 0.5 : 1,
                        }}
                      >
                        {actioning === s.id ? '…' : '✓ Approve'}
                      </button>
                      <button
                        onClick={() => handleReject(s.id)}
                        disabled={actioning === s.id}
                        className="font-jb text-[10px] px-2.5 py-1 rounded"
                        style={{
                          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
                          color: '#ef4444', cursor: actioning === s.id ? 'not-allowed' : 'pointer',
                          opacity: actioning === s.id ? 0.5 : 1,
                        }}
                      >
                        ✗ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Section 1: Tracked Pairs ── */}
        <div className="s-card">
          <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <SectionHeader
              title="Tracked Pairs"
              count={filteredPairs.length}
              extra={
                <div className="flex gap-1">
                  {(['all', 'active', 'inactive'] as const).map(f => (
                    <button key={f} onClick={() => setPairsFilter(f)}
                      className="font-jb text-[9px] px-2 py-0.5 rounded capitalize"
                      style={{
                        background: pairsFilter === f ? 'var(--reticle)' : 'var(--bg-secondary)',
                        border: `1px solid ${pairsFilter === f ? 'var(--reticle)' : 'var(--border-strong)'}`,
                        color: pairsFilter === f ? '#000' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            />
          </div>

          {filteredPairs.length === 0 ? (
            <p className="px-5 py-6 font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              {loading ? 'Loading…' : 'No pairs found'}
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 64px 80px 160px', minWidth: 780, borderBottom: '1px solid var(--border)' }}>
                <TH>Market A</TH>
                <TH>Market B</TH>
                <TH>Relationship</TH>
                <TH>Status</TH>
                <TH>Live</TH>
                <TH>Created</TH>
              </div>
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {filteredPairs.map((p, i) => (
                  <div key={p.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 80px 64px 80px 160px', minWidth: 780,
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                    borderBottom: '1px solid var(--border)', alignItems: 'center',
                  }}>
                    <TD>
                      <a href={polyLink(p.market_a_slug)} target="_blank" rel="noopener noreferrer"
                        className="font-jb text-[10px]"
                        style={{ color: 'var(--riskfree)', textDecoration: 'none' }}
                        title={p.market_a_slug}
                      >
                        ↗ {p.market_a_slug}
                      </a>
                    </TD>
                    <TD>
                      <a href={polyLink(p.market_b_slug)} target="_blank" rel="noopener noreferrer"
                        className="font-jb text-[10px]"
                        style={{ color: 'var(--riskfree)', textDecoration: 'none' }}
                        title={p.market_b_slug}
                      >
                        ↗ {p.market_b_slug}
                      </a>
                    </TD>
                    <TD>
                      <span className="font-jb text-[10px] px-1.5 py-0.5 rounded" style={{
                        background: p.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.1)' : 'rgba(91,155,208,0.1)',
                        border: `1px solid ${p.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.2)' : 'rgba(91,155,208,0.2)'}`,
                        color: p.relationship === 'mutually_exclusive' ? '#ef4444' : 'var(--riskfree)',
                      }}>
                        {relLabel(p.relationship)}
                      </span>
                    </TD>
                    <TD>
                      <span className="font-jb text-[9px] px-1.5 py-0.5 rounded-full" style={{
                        background: p.active ? 'rgba(74,222,128,0.1)' : 'rgba(120,120,120,0.08)',
                        border: `1px solid ${p.active ? 'rgba(74,222,128,0.25)' : 'rgba(120,120,120,0.2)'}`,
                        color: p.active ? 'var(--profit)' : 'var(--text-muted)',
                      }}>
                        {p.active ? 'active' : 'inactive'}
                      </span>
                    </TD>
                    <TD>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const newVal = !p.live_eligible;
                          setPairs(prev => prev.map(pp => pp.id === p.id ? { ...pp, live_eligible: newVal } : pp));
                          const res = await fetch(`/api/logic-arb/pairs/${p.id}/live-eligible`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ live_eligible: newVal }),
                          });
                          if (!res.ok) {
                            setPairs(prev => prev.map(pp => pp.id === p.id ? { ...pp, live_eligible: !newVal } : pp));
                          }
                        }}
                        className="relative inline-flex items-center rounded-full transition-colors duration-200 focus:outline-none"
                        style={{
                          width: 32, height: 18,
                          background: p.live_eligible ? 'rgba(74,222,128,0.6)' : 'var(--border-strong)',
                          cursor: 'pointer', flexShrink: 0, border: 'none',
                        }}
                      >
                        <span style={{
                          display: 'block', width: 12, height: 12, borderRadius: '50%', background: 'white',
                          transform: p.live_eligible ? 'translateX(16px)' : 'translateX(2px)',
                          transition: 'transform 0.2s',
                        }} />
                      </button>
                    </TD>
                    <TD style={{ color: 'var(--text-muted)' }}>{fmt(p.created_at)}</TD>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Section 3: Summary by Market Pair ── */}
        {tradeSummary.length > 0 && (() => {
          // Sortable summary table
          function sortSummary(rows: PairSummary[]): PairSummary[] {
            const { col, dir } = summarySort;
            return [...rows].sort((a, b) => {
              const pick = (r: PairSummary): number => {
                if (col === 'count')           return r.count;
                if (col === 'avgDeviationPct') return r.avgDeviationPct;
                if (col === 'avgInvestedUsd')  return r.avgInvestedUsd;
                if (col === 'avgProfitUsd')    return r.avgProfitUsd;
                return r.totalProfitUsd;
              };
              return dir === 'desc' ? pick(b) - pick(a) : pick(a) - pick(b);
            });
          }

          function SortTH({ col, children, right }: { col: SummarySortCol; children: React.ReactNode; right?: boolean }) {
            const active = summarySort.col === col;
            return (
              <button
                onClick={() => setSummarySort(prev =>
                  prev.col === col ? { col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' }
                )}
                className="font-jb text-[9px] uppercase tracking-wider py-2 px-3 flex items-center gap-1"
                style={{
                  color: active ? 'var(--reticle)' : 'var(--text-muted)',
                  textAlign: right ? 'right' : 'left',
                  cursor: 'pointer', background: 'none', border: 'none', width: '100%',
                  justifyContent: right ? 'flex-end' : 'flex-start',
                }}
              >
                {children}
                {active && <span style={{ opacity: 0.8 }}>{summarySort.dir === 'desc' ? '▼' : '▲'}</span>}
              </button>
            );
          }

          const sorted = sortSummary(tradeSummary);

          return (
            <div className="s-card">
              <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <SectionHeader
                  title="Summary by Market Pair"
                  count={tradeSummary.length}
                  extra={
                    tradeTotals && (
                      <div className="flex items-center gap-3 font-jb text-[11px]">
                        <span style={{ color: 'var(--text-muted)' }}>
                          Avg dev <span style={{ color: 'var(--text-primary)' }}>{tradeTotals.avgDeviationPct.toFixed(2)}%</span>
                        </span>
                        <span style={{ color: 'var(--border-strong)' }}>│</span>
                        <span style={{ color: tradeTotals.totalProfitUsd >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
                          Total P&L ${tradeTotals.totalProfitUsd.toFixed(2)}
                        </span>
                      </div>
                    )
                  }
                />
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 60px 100px 110px 110px 110px', minWidth: 760, borderBottom: '1px solid var(--border)' }}>
                  <TH>Market Pair</TH>
                  <TH>Type</TH>
                  <SortTH col="count" right>Cnt</SortTH>
                  <SortTH col="avgDeviationPct" right>Avg Dev</SortTH>
                  <SortTH col="avgInvestedUsd" right>Avg Invested</SortTH>
                  <SortTH col="avgProfitUsd" right>Avg Profit</SortTH>
                  <SortTH col="totalProfitUsd" right>Total P&L</SortTH>
                </div>
                <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {sorted.map((s, i) => (
                    <div key={s.marketPairLabel} style={{
                      display: 'grid', gridTemplateColumns: '1fr 80px 60px 100px 110px 110px 110px', minWidth: 760,
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      borderBottom: '1px solid var(--border)', alignItems: 'center',
                    }}>
                      <div className="font-inter text-[11px] py-2 px-3 truncate" style={{ color: 'var(--text-secondary)' }} title={s.marketPairLabel}>
                        {s.marketPairLabel}
                      </div>
                      <TD>
                        <span className="font-jb text-[9px] px-1.5 py-0.5 rounded" style={{
                          background: s.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.1)' : s.relationship === 'a_implies_b' ? 'rgba(91,155,208,0.1)' : 'rgba(120,120,120,0.1)',
                          border: `1px solid ${s.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.2)' : s.relationship === 'a_implies_b' ? 'rgba(91,155,208,0.2)' : 'rgba(120,120,120,0.2)'}`,
                          color: s.relationship === 'mutually_exclusive' ? '#ef4444' : s.relationship === 'a_implies_b' ? 'var(--riskfree)' : 'var(--text-muted)',
                        }}>
                          {s.relationship === 'a_implies_b' ? 'A→B' : s.relationship === 'mutually_exclusive' ? 'MUTEX' : 'MIXED'}
                        </span>
                      </TD>
                      <TD right style={{ color: 'var(--text-primary)' }}>{s.count}</TD>
                      <TD right style={{ color: 'var(--directional)' }}>{s.avgDeviationPct.toFixed(2)}%</TD>
                      <TD right style={{ color: 'var(--text-secondary)' }}>${s.avgInvestedUsd.toFixed(2)}</TD>
                      <TD right style={{ color: pnlColor(s.avgProfitUsd) }}>${s.avgProfitUsd.toFixed(4)}</TD>
                      <TD right style={{ color: pnlColor(s.totalProfitUsd) }}>${s.totalProfitUsd.toFixed(2)}</TD>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Section 4: Trade History ── */}
        <div className="s-card">
          <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <SectionHeader
              title="Trade History (logic-arb)"
              count={totalTrades}
              extra={
                <span className="font-jb text-[11px]" style={{ color: settledPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}>
                  Settled P&L: ${settledPnl.toFixed(2)}
                </span>
              }
            />
          </div>

          {trades.length === 0 ? (
            <p className="px-5 py-6 font-inter text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              {loading ? 'Loading…' : 'No trades yet'}
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 100px 100px 130px 20px', minWidth: 760, borderBottom: '1px solid var(--border)' }}>
                <TH>Market / Pair</TH>
                <TH>Type</TH>
                <TH right>Dev %</TH>
                <TH right>Invested</TH>
                <TH right>Net P&L</TH>
                <TH>Opened</TH>
                <TH>{''}</TH>
              </div>
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                {trades.map((t, i) => {
                  const isExpanded = expandedTrade === t.id;
                  return (
                    <div key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      {/* Main row — click to expand */}
                      <div
                        onClick={() => setExpandedTrade(isExpanded ? null : t.id)}
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 80px 90px 100px 100px 130px 20px',
                          minWidth: 760,
                          background: isExpanded
                            ? 'rgba(255,77,46,0.05)'
                            : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                          alignItems: 'center', cursor: 'pointer',
                        }}
                      >
                        <TD style={{ color: 'var(--text-primary)' }}>
                          <span title={t.market_pair_label}>{t.market_pair_label}</span>
                          {t.trading_mode === 'live' && (
                            <span className="font-jb text-[8px] px-1 py-0.5 rounded ml-1" style={{
                              background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                              color: '#ef4444', verticalAlign: 'middle',
                            }}>LIVE</span>
                          )}
                        </TD>
                        <TD>
                          <span className="font-jb text-[9px] px-1.5 py-0.5 rounded" style={{
                            background: t.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.1)' : 'rgba(91,155,208,0.1)',
                            border: `1px solid ${t.relationship === 'mutually_exclusive' ? 'rgba(239,68,68,0.2)' : 'rgba(91,155,208,0.2)'}`,
                            color: t.relationship === 'mutually_exclusive' ? '#ef4444' : 'var(--riskfree)',
                          }}>
                            {relLabel(t.relationship)}
                          </span>
                        </TD>
                        <TD right style={{ color: 'var(--directional)' }}>{t.deviationPct.toFixed(2)}%</TD>
                        <TD right style={{ color: 'var(--text-secondary)' }}>${t.totalInvestedUsd.toFixed(2)}</TD>
                        <TD right style={{ color: pnlColor(t.netProfitUsd) }}>${t.netProfitUsd.toFixed(4)}</TD>
                        <TD style={{ color: 'var(--text-muted)' }}>{fmt(t.opened_at)}</TD>
                        <div className="font-inter text-[10px] py-2 px-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                          {isExpanded ? '▲' : '▼'}
                        </div>
                      </div>

                      {/* Expanded detail panel */}
                      {isExpanded && (
                        <div style={{
                          background: 'rgba(255,77,46,0.03)',
                          borderTop: '1px solid rgba(255,77,46,0.12)',
                          padding: '12px 16px',
                        }}>
                          {/* Two-column leg layout */}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
                            {[
                              { label: 'Leg A', leg: t.legA },
                              { label: 'Leg B', leg: t.legB },
                            ].map(({ label, leg }) => (
                              <div key={label} style={{
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid var(--border)',
                                borderRadius: 6, padding: '10px 12px',
                              }}>
                                <div className="font-jb text-[9px] uppercase tracking-wider mb-2" style={{ color: 'var(--reticle)' }}>
                                  {label}
                                </div>
                                {/* Action badge */}
                                <div className="mb-2">
                                  <span className="font-jb text-[10px] px-2 py-0.5 rounded" style={{
                                    background: leg.token === 'YES' ? 'rgba(74,222,128,0.12)' : 'rgba(239,68,68,0.10)',
                                    border: `1px solid ${leg.token === 'YES' ? 'rgba(74,222,128,0.25)' : 'rgba(239,68,68,0.22)'}`,
                                    color: leg.token === 'YES' ? 'var(--profit)' : '#ef4444',
                                  }}>
                                    {leg.action}
                                  </span>
                                </div>
                                {/* Market slug link */}
                                <a
                                  href={polyLink(leg.marketSlug)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  className="font-jb text-[10px] block truncate mb-2"
                                  style={{ color: 'var(--riskfree)', textDecoration: 'none' }}
                                  title={leg.marketSlug}
                                >
                                  ↗ {leg.marketSlug}
                                </a>
                                {/* Price / notional */}
                                <div className="font-jb text-[10px] space-y-0.5">
                                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Fill price</span>
                                    <span style={{ color: 'var(--text-primary)' }}>${leg.fillPrice.toFixed(4)}</span>
                                  </div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Notional (×{t.shares})</span>
                                    <span style={{ color: 'var(--text-primary)' }}>${leg.notionalUsd.toFixed(4)}</span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* Footer row: totals + fee */}
                          <div className="font-jb text-[10px] flex flex-wrap gap-4" style={{ color: 'var(--text-muted)' }}>
                            <span>
                              Total invested <span style={{ color: 'var(--text-primary)' }}>${t.totalInvestedUsd.toFixed(4)}</span>
                            </span>
                            <span style={{ color: 'var(--border-strong)' }}>│</span>
                            <span>
                              Deviation <span style={{ color: 'var(--directional)' }}>{t.deviationPct.toFixed(2)}%</span>
                            </span>
                            <span style={{ color: 'var(--border-strong)' }}>│</span>
                            <span>
                              Fee rate <span style={{ color: 'var(--text-secondary)' }}>{(t.feeRate * 100).toFixed(2)}%</span>
                            </span>
                            <span style={{ color: 'var(--border-strong)' }}>│</span>
                            <span>
                              Net profit <span style={{ color: pnlColor(t.netProfitUsd) }}>${t.netProfitUsd.toFixed(6)}</span>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="px-5 py-2 font-inter text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Showing {trades.length} of {totalTrades} trades · click any row to expand leg details
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
