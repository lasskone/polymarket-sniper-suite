import { useState, useEffect, useCallback } from 'react';

export interface ModuleStat {
  tradeCount: number;
  totalNetProfitUsd: number;
  avgProfitPerTrade: number;
  lastTradeAt: string | null;
}

export interface PaperStats {
  byModule: Record<string, ModuleStat>;
  total: ModuleStat;
}

const emptyModuleStat: ModuleStat = {
  tradeCount: 0,
  totalNetProfitUsd: 0,
  avgProfitPerTrade: 0,
  lastTradeAt: null,
};

export const emptyPaperStats: PaperStats = {
  byModule: {},
  total: { ...emptyModuleStat },
};

// When served by the bot (production), the API is on the same origin.
// When running vite dev (port 5173), point at the bot's HTTP port.
const API_BASE = window.location.port === '5173'
  ? `http://${window.location.hostname}:8080`
  : '';

/**
 * Fetches /api/paper-stats on mount and whenever `refreshToken` changes.
 * Pass a value derived from incoming SIGNAL logs to trigger live updates.
 */
export function usePaperStats(refreshToken?: number): PaperStats {
  const [stats, setStats] = useState<PaperStats>(emptyPaperStats);

  const load = useCallback(() => {
    fetch(`${API_BASE}/api/paper-stats`)
      .then((r) => r.json())
      .then((data) => setStats(data as PaperStats))
      .catch(() => setStats(emptyPaperStats));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  return stats;
}
