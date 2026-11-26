export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

// Logging utility for the AURA project, providing leveled logging with structured fields and error tracking.
const RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let errorCount = 0;

// Determines the numeric threshold for the current log level based on the AURA_LOG_LEVEL environment variable.
function threshold(): number {
  const configured = (process.env.AURA_LOG_LEVEL || 'info').toLowerCase();
  return RANK[configured] ?? RANK.info;
}

// Converts an unknown error into a structured object with a message and optional stack trace.
function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

// Normalizes log fields by removing undefined values and formatting errors appropriately.
function normalizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'error') {
      const { message, stack } = describeError(value);
      out.error = message;
      if (stack && threshold() <= RANK.debug) out.stack = stack;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Formats the log message as a single line of text with key=value pairs for structured fields.
function formatText(level: LogLevel, message: string, fields: LogFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /^[\w./\\:@-]+$/.test(text) ? `${key}=${text}` : `${key}=${JSON.stringify(text)}`;
  });
  return [`[${level.toUpperCase()}] ${message}`, ...pairs].join(' ');
}

// Emits the log message to the console if it meets the current log level threshold, incrementing the error count for 'error' level logs.
function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (level === 'error') errorCount += 1;
  if (RANK[level] < threshold()) return;
  const normalized = normalizeFields(fields);
  const line = process.env.AURA_LOG_FORMAT === 'json'
    ? JSON.stringify({ level, message, ...normalized })
    : formatText(level, message, normalized);
  if (level === 'info' || level === 'debug') console.log(line);
  else console.error(line);
}

export const logDebug = (message: string, fields?: LogFields) => emit('debug', message, fields);
export const logInfo = (message: string, fields?: LogFields) => emit('info', message, fields);
export const logWarn = (message: string, fields?: LogFields) => emit('warn', message, fields);
export const logError = (message: string, fields?: LogFields) => emit('error', message, fields);

export const getErrorCount = () => errorCount;
export const resetErrorCount = () => { errorCount = 0; };

/**
 * Runs a CLI entry point and sets a non-zero exit code on any thrown error or
 * logged error, so failures stay visible in CI even when processing continued.
 */
export async function runCli(main: () => Promise<number | void> | number | void): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    logError('unhandled promise rejection', { error: reason });
    process.exit(1);
  });
  try {
    const code = await main();
    process.exitCode = code || (errorCount > 0 ? 1 : 0);
  } catch (err) {
    logError('script failed', { error: err });
    process.exitCode = 1;
  }
}
