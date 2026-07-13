import type { BotConfig } from '../types';

interface StrategyControlsProps {
    config: BotConfig | null;
    onToggle: (strategy: string, enabled: boolean) => void;
}

interface ToggleProps {
    label: string;
    enabled: boolean;
    icon: string;
    color: string;
    onChange: (enabled: boolean) => void;
}

function Toggle({ label, enabled, icon, color, onChange }: ToggleProps) {
    return (
        <div className="flex items-center justify-between p-3 rounded-xl bg-poly-dark/50 border border-white/5">
            <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg bg-${color}-500/20 flex items-center justify-center text-sm`}>
                    {icon}
                </div>
                <span className="text-white font-medium">{label}</span>
            </div>
            <button
                onClick={() => onChange(!enabled)}
                className={`relative w-12 h-6 rounded-full transition-all duration-300 ${enabled ? `bg-${color}-500` : 'bg-gray-700'
                    }`}
            >
                <div
                    className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-300 ${enabled ? 'translate-x-6' : 'translate-x-0'
                        }`}
                />
            </button>
        </div>
    );
}

export function StrategyControls({ config, onToggle }: StrategyControlsProps) {
    if (!config) return null;

    // Only list strategies that have a real implementation wired in bot/index.ts.
    // Stub strategies (smartMoney, arbitrage, directTrading) are omitted so they
    // never appear as toggleable controls that send commands into the void.
    const liveStrategies = [
        {
            key: 'dipArb',
            label: 'DipArb (Crypto Short-Term)',
            icon: '📉',
            color: 'green',
            enabled: config.dipArb?.enabled ?? false,
        },
    ];

    const detectionStrategies = [
        {
            key: 'negRiskArb',
            label: 'NegRisk Arb',
            icon: '⚖️',
            color: 'orange',
            enabled: config.negRiskArb?.enabled ?? false,
        },
        {
            key: 'logicArb',
            label: 'Logic Arb',
            icon: '🔗',
            color: 'purple',
            enabled: config.logicArb?.enabled ?? false,
        },
        {
            key: 'sportsbookArb',
            label: 'Sportsbook Arb',
            icon: '🏆',
            color: 'cyan',
            enabled: config.sportsbookArb?.enabled ?? false,
        },
    ];

    return (
        <div className="panel">
            <div className="panel-header">
                <h3 className="section-header mb-0">
                    <div className="section-header-icon bg-gradient-to-br from-purple-500/20 to-blue-500/20">⚙️</div>
                    Strategy Controls
                </h3>
            </div>
            <div className="panel-body space-y-2">
                {liveStrategies.map((s) => (
                    <Toggle
                        key={s.key}
                        label={s.label}
                        icon={s.icon}
                        color={s.color}
                        enabled={s.enabled}
                        onChange={(enabled) => onToggle(s.key, enabled)}
                    />
                ))}
                <div className="text-xs text-gray-500 pt-1 pb-0.5 uppercase tracking-wider">
                    Detection-only (read-only)
                </div>
                {detectionStrategies.map((s) => (
                    <Toggle
                        key={s.key}
                        label={s.label}
                        icon={s.icon}
                        color={s.color}
                        enabled={s.enabled}
                        onChange={(enabled) => onToggle(s.key, enabled)}
                    />
                ))}
                <div className="text-xs text-gray-500 mt-2 text-center leading-relaxed">
                    DipArb: changes take effect immediately.<br />
                    <span className="text-gray-600">Detection modules: env flag — restart required to toggle.</span>
                </div>
            </div>
        </div>
    );
}
