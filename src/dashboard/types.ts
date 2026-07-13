/**
 * Dashboard Types - Shared between server and client
 */

export interface BotState {
  startTime: number;
  dailyPnL: number;
  totalPnL: number;
  consecutiveLosses: number;
  consecutiveWins: number;  // 🔴 NEW v3.1
  tradesExecuted: number;
  isPaused: boolean;
  pauseUntil: number;

  // 🔴 NEW v3.1: Enhanced risk tracking
  monthlyPnL: number;
  monthStartTime: number;
  peakCapital: number;
  currentCapital: number;
  currentDrawdown: number;
  permanentlyHalted: boolean;
  lastDailyReset: number;

  // Strategy stats
  smartMoneyTrades: number;
  arbTrades: number;
  dipArbTrades: number;
  directTrades: number;
  arbProfit: number;

  // Tracked data
  followedWallets: string[];
  positions: any[]; // Portfolio Sync
  activeArbMarket: string | null;
  activeDipArbMarket: string | null;

  // On-chain stats
  splits: number;
  merges: number;
  redeems: number;
  swaps: number;

  // Balances
  usdcBalance: number;
  usdcEBalance: number;
  maticBalance: number;
  unrealizedPnL: number;

  // Analysis
  btcTrend: 'up' | 'down' | 'neutral';
  ethTrend: 'up' | 'down' | 'neutral';
  solTrend: 'up' | 'down' | 'neutral';

  // DipArb live data
  dipArb: {
    marketName: string | null;
    underlying: string | null;
    duration: string | null;
    endTime: number | null;
    upPrice: number;
    downPrice: number;
    sum: number;
    status?: 'active' | 'idle' | 'scanning'; // Added status field
    lastSignal: DipArbSignal | null;
    signals: DipArbSignal[];
  };

  // Arbitrage live data
  arbitrage: {
    status: 'scanning' | 'monitoring' | 'idle';
    marketsScanned: number;
    opportunitiesFound: number;
    currentMarket: string | null;
    lastOpportunity: ArbOpportunity | null;
  };

  // Smart Money signals
  smartMoneySignals: SmartMoneySignal[];

  // NegRisk arbitrage detection
  negRiskArb: {
    status: 'scanning' | 'idle';
    eventsScanned: number;
    candidatesFound: number;
    lastSignal: NegRiskArbSignal | null;
    recentSignals: NegRiskArbSignal[];
  };

  // Logic / correlated-markets arbitrage detection
  logicArb: {
    status: 'scanning' | 'idle';
    pairsTracked: number;
    pairsScanned: number;
    lastSignal: LogicArbDashboardSignal | null;
    recentSignals: LogicArbDashboardSignal[];
  };

  // Sportsbook arbitrage detection
  sportsbookArb: {
    status: 'scanning' | 'idle';
    fixturesScanned: number;
    polymarketCoverageRatio: number;
    lastSignal: SportsbookArbDashboardSignal | null;
    recentSignals: SportsbookArbDashboardSignal[];
  };

  // Paper Trading (Dry Run)
  paper?: {
    balance: number;
    initialBalance: number;
    pnl: number;
    trades: number;
    totalVolume: number;
  };
}

export interface DipArbSignal {
  id: string;
  timestamp: string;
  type: 'dip' | 'surge' | 'leg1' | 'leg2';
  side: 'UP' | 'DOWN';
  price: number;
  change: number;
}

export interface ArbOpportunity {
  timestamp: string;
  type: 'long' | 'short';
  profitPct: number;
  market: string;
}

export interface SmartMoneySignal {
  id: string;
  timestamp: string;
  wallet: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

export interface NegRiskArbSignal {
  eventTitle: string;
  direction: string;
  yesSum: number;
  netProfitUSD: number;
  outcomeCount: number;
  deviation: number;
  timestamp: string;
}

export interface LogicArbDashboardSignal {
  relationship: string;
  marketASlug: string;
  marketBSlug: string;
  priceA: number;
  priceB: number;
  deviation: number;
  netProfitUSD: number;
  timestamp: string;
}

export interface SportsbookArbDashboardSignal {
  participant1Name: string;
  participant2Name: string;
  tournamentName: string;
  outcomeName: string;
  edge: number;
  expectedNetProfitUSD: number;
  confidence: number;
  timestamp: string;
}

export interface BotConfig {
  capital: {
    totalUsd: number;
    maxPerTradePct: number;
    maxPerMarketPct: number;
    maxTotalExposurePct: number;
    minOrderUsd: number;
    strategyAllocation: {
      smartMoney: number;
      arbitrage: number;
      dipArb: number;
      directTrades: number;
    };
  };
  risk: {
    dailyMaxLossPct: number;
    maxConsecutiveLosses: number;
    pauseOnBreachMinutes: number;
  };
  smartMoney: {
    enabled: boolean;
    topN: number;
    minWinRate: number;
    minPnl: number;
    minTrades: number;
    customWallets: string[];
  };
  arbitrage: {
    enabled: boolean;
    profitThreshold: number;
    autoExecute: boolean;
  };
  dipArb: {
    enabled: boolean;
    coins: readonly string[];
  };
  negRiskArb: {
    enabled: boolean;
  };
  logicArb: {
    enabled: boolean;
  };
  sportsbookArb: {
    enabled: boolean;
  };
  directTrading: {
    enabled: boolean;
  };
  binance: {
    enabled: boolean;
  };
  dryRun: boolean;
}

export type LogLevel =
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'TRADE'
  | 'SIGNAL'
  | 'ARB'
  | 'WALLET'
  | 'CHAIN'
  | 'SWAP'
  | 'BRIDGE'
  | 'KLINE'
  | 'TREND';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface DashboardData {
  state: BotState;
  config: BotConfig;
  logs: LogEntry[];
}

export interface WebSocketMessage {
  type: 'state' | 'log' | 'config' | 'full';
  payload: unknown;
}
