import { useState, useMemo } from 'react';
import type { LogEntry, LogLevel } from '../types';

interface ActivityLogProps {
  logs: LogEntry[];
}

const LOG_COLORS: Record<LogLevel, string> = {
  INFO:   'text-white/35',
  WARN:   'text-yellow-400',
  ERROR:  'text-red-400',
  TRADE:  'text-emerald-400',
  SIGNAL: 'text-violet-400',
  ARB:    'text-blue-400',
  WALLET: 'text-pink-400',
  CHAIN:  'text-orange-400',
  SWAP:   'text-cyan-400',
  BRIDGE: 'text-indigo-400',
  KLINE:  'text-teal-400',
  TREND:  'text-emerald-400',
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
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-[420px]">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-white/[0.05] shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white/80">Activity Log</h2>
          <span className="text-[10px] text-white/25">{filteredLogs.length}</span>
        </div>

        <div className="flex gap-1">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                filter === opt
                  ? 'bg-white/10 text-white/80'
                  : 'text-white/25 hover:text-white/50'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Log items */}
      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-2xl opacity-20 mb-2">📭</p>
            <p className="text-xs text-white/25">No logs to display</p>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const levelColor = LOG_COLORS[log.level];
            return (
              <div
                key={log.id}
                className="flex items-start gap-3 py-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
                onClick={() => setExpanded(expanded === log.id ? null : log.id)}
              >
                <span className="font-mono text-[10px] text-white/20 w-16 shrink-0 pt-px">{formatTime(log.timestamp)}</span>
                <span className={`font-semibold text-[10px] w-12 shrink-0 pt-px ${levelColor}`}>{log.level}</span>
                <span className="text-[11px] text-white/55 flex-1 break-words leading-relaxed">{log.message}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-2 border-t border-white/[0.04] flex items-center justify-between shrink-0">
        <span className="text-[10px] text-white/20">Latest first</span>
        <span className="flex items-center gap-1.5 text-[10px] text-white/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Live
        </span>
      </div>
    </div>
  );
}
