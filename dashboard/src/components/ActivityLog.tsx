import { useState, useMemo } from 'react';
import type { LogEntry, LogLevel } from '../types';

interface ActivityLogProps {
  logs: LogEntry[];
}

const LOG_COLORS: Record<LogLevel, string> = {
  INFO:   'var(--text-muted)',
  WARN:   '#f59e0b',
  ERROR:  'var(--loss)',
  TRADE:  'var(--profit)',
  SIGNAL: '#a78bfa',
  ARB:    'var(--riskfree)',
  WALLET: '#f472b6',
  CHAIN:  '#fb923c',
  SWAP:   '#22d3ee',
  BRIDGE: '#818cf8',
  KLINE:  '#2dd4bf',
  TREND:  'var(--profit)',
};

const FILTER_OPTIONS: (LogLevel | 'ALL')[] = [
  'ALL', 'TRADE', 'SIGNAL', 'ARB', 'WALLET', 'ERROR', 'WARN', 'INFO',
];

export function ActivityLog({ logs }: ActivityLogProps) {
  const [filter, setFilter] = useState<LogLevel | 'ALL'>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filteredLogs = useMemo(() => {
    if (filter === 'ALL') return logs;
    return logs.filter((log) => log.level === filter);
  }, [logs, filter]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  };

  return (
    <div className="s-card flex flex-col" style={{ height: 520 }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-3">
          <h2 className="font-space text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Activity Log</h2>
          <span className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>{filteredLogs.length}</span>
        </div>
        <div className="flex gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className="font-jb text-[9px] px-2 py-1 rounded transition-colors"
              style={{
                background: filter === opt ? 'var(--glass-strong)' : 'transparent',
                color: filter === opt ? 'var(--text-primary)' : 'var(--text-muted)',
                border: filter === opt ? '1px solid var(--border-strong)' : '1px solid transparent',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Log rows */}
      <div className="flex-1 overflow-y-auto px-5 py-2 space-y-px">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <p className="font-inter text-xs mb-1" style={{ color: 'var(--text-muted)' }}>No logs to display</p>
            <p className="font-inter text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Activity will appear here</p>
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-3 py-1.5 px-1 -mx-1 rounded cursor-pointer transition-colors hover:bg-white/[0.02]"
              onClick={() => setExpanded(expanded === log.id ? null : log.id)}
            >
              <span className="font-jb text-[9px] w-16 shrink-0 pt-px" style={{ color: 'var(--text-muted)' }}>
                {formatTime(log.timestamp)}
              </span>
              <span
                className="font-jb text-[9px] w-12 shrink-0 pt-px font-semibold"
                style={{ color: LOG_COLORS[log.level] }}
              >
                {log.level}
              </span>
              <span className="font-inter text-[11px] flex-1 break-words leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between px-5 py-2 shrink-0"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <span className="font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>Latest first</span>
        <span className="flex items-center gap-1.5 font-jb text-[9px]" style={{ color: 'var(--text-muted)' }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--profit)' }} />
          Live
        </span>
      </div>
    </div>
  );
}
