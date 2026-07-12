/**
 * Minimal structured logger for the sniper suite.
 * Drop-in compatible with console; upgrade to pino/winston as needed.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
  debug: (msg: string) => log('debug', msg),
};
