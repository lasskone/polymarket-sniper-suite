import type { BotState } from '../types';

interface BalanceCardsProps {
  state: BotState | null;
}

export function BalanceCards({ state }: BalanceCardsProps) {
  const matic = state?.maticBalance ?? 0;
  const usdc = state?.usdcBalance ?? 0;
  const usdce = state?.usdcEBalance ?? 0;
  const total = usdc + usdce;

  const rows = [
    { label: 'MATIC', value: matic.toFixed(4), sub: 'Gas', color: 'text-violet-400' },
    { label: 'USDC', value: `$${usdc.toFixed(2)}`, sub: 'Bridged', color: 'text-emerald-400' },
    { label: 'USDC.e', value: `$${usdce.toFixed(2)}`, sub: 'Native', color: 'text-blue-400' },
    { label: 'Total', value: `$${total.toFixed(2)}`, sub: 'Capital', color: 'text-white/80' },
  ];

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-full">
      <div className="px-5 pt-5 pb-4">
        <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-white/25 mb-1">Wallet</p>
        <h2 className="text-base font-semibold text-white/90">Balances</h2>
      </div>

      <div className="px-5 pb-5 flex-1 flex flex-col justify-between gap-3">
        {rows.map(({ label, value, sub, color }) => (
          <div key={label} className="stat-row">
            <div className="flex items-baseline gap-2">
              <span className="stat-label">{label}</span>
              <span className="text-[9px] text-white/20">{sub}</span>
            </div>
            <span className={`text-sm font-mono font-semibold ${color}`}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
