/**
 * Structured JSON logger for the Polymarket Sniper Suite.
 *
 * Output format (one JSON object per line — Railway/stdout friendly):
 *   {"timestamp":"…","level":"INFO","module":"latency-sniper","message":"…","data":{…}}
 *
 * Log level filtering:
 *   NODE_ENV=production  → INFO and above  (DEBUG suppressed)
 *   everything else      → all levels
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const MIN_LEVEL: LogLevel =
  process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------

export class Logger {
  constructor(private readonly moduleName: string) {}

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.moduleName,
      message,
      ...(data !== undefined && { data }),
    };

    const line = JSON.stringify(entry);

    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write('DEBUG', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write('INFO', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write('WARN', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write('ERROR', message, data);
  }
}

// ---------------------------------------------------------------------------

/**
 * Factory — preferred entry point.
 *
 * @example
 *   const logger = createLogger('latency-sniper');
 *   logger.info('Opportunity detected', { marketId: '123', edge: 0.05 });
 *   logger.error('Trade failed', { error: 'Insufficient balance' });
 */
export function createLogger(moduleName: string): Logger {
  return new Logger(moduleName);
}
