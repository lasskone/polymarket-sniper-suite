import type { BotState } from '../types';

interface BalanceCardsProps {
  state: BotState | null;
}

export function BalanceCards({ state }: BalanceCardsProps) {
  const matic = state?.maticBalance ?? 0;
  const usdc  = state?.usdcBalance  ?? 0;
  const usdce = state?.usdcEBalance ?? 0;
  const total = usdc + usdce;

  const rows = [
    { label: 'MATIC',  value: matic.toFixed(4),    sub: 'Gas',     color: '#a78bfa' },
    { label: 'USDC',   value: `$${usdc.toFixed(2)}`,  sub: 'Bridged', color: 'var(--profit)' },
    { label: 'USDC.e', value: `$${usdce.toFixed(2)}`, sub: 'Native',  color: 'var(--riskfree)' },
    { label: 'Total',  value: `$${total.toFixed(2)}`,  sub: 'Capital', color: 'var(--text-primary)' },
  ];

  return (
    <div className="s-card flex flex-col h-full">
      <div className="px-5 pt-5 pb-3">
        <p className="font-jb text-[9px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>Wallet</p>
        <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Balances</h2>
      </div>
      <div className="px-5 pb-5 flex-1 flex flex-col justify-between gap-3">
        {rows.map(({ label, value, sub, color }) => (
          <div key={label} className="s-stat-row">
            <div className="flex items-baseline gap-2">
              <span className="font-inter text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
              <span className="font-jb text-[9px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{sub}</span>
            </div>
            <span className="font-jb text-sm font-semibold" style={{ color }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
