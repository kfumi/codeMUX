import { attachConsole, debug, error, info, trace, warn } from '@tauri-apps/plugin-log';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

type Logger = {
  trace: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext, err?: unknown) => void;
  error: (message: string, context?: LogContext, err?: unknown) => void;
};

let loggingInitialized = false;

function isTauriRuntime() {
  return (
    typeof window !== 'undefined' &&
    typeof (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Error) {
    return value.stack || value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeContext(context?: LogContext, err?: unknown) {
  const keyValues: Record<string, string> = {};

  if (context) {
    for (const [key, value] of Object.entries(context)) {
      const normalized = stringifyValue(value);
      if (normalized) {
        keyValues[key] = normalized;
      }
    }
  }

  if (err !== undefined) {
    keyValues.error = stringifyValue(err);
  }

  return Object.keys(keyValues).length > 0 ? keyValues : undefined;
}

function formatConsolePayload(scope: string, message: string, context?: LogContext, err?: unknown) {
  return [`[${scope}] ${message}`, context, err].filter((value) => value !== undefined);
}

async function emit(level: LogLevel, scope: string, message: string, context?: LogContext, err?: unknown) {
  const scopedMessage = `[${scope}] ${message}`;
  const keyValues = normalizeContext(context, err);

  if (isTauriRuntime()) {
    const options = keyValues ? { keyValues } : undefined;

    try {
      switch (level) {
        case 'trace':
          await trace(scopedMessage, options);
          return;
        case 'debug':
          await debug(scopedMessage, options);
          return;
        case 'info':
          await info(scopedMessage, options);
          return;
        case 'warn':
          await warn(scopedMessage, options);
          return;
        case 'error':
          await error(scopedMessage, options);
          return;
      }
    } catch (logError) {
      console.error('[logger] Failed to write Tauri log', logError);
    }
  }

  const payload = formatConsolePayload(scope, message, context, err);
  switch (level) {
    case 'trace':
      console.debug(...payload);
      break;
    case 'debug':
      console.debug(...payload);
      break;
    case 'info':
      console.info(...payload);
      break;
    case 'warn':
      console.warn(...payload);
      break;
    case 'error':
      console.error(...payload);
      break;
  }
}

export function createLogger(scope: string): Logger {
  return {
    trace(message, context) {
      void emit('trace', scope, message, context);
    },
    debug(message, context) {
      void emit('debug', scope, message, context);
    },
    info(message, context) {
      void emit('info', scope, message, context);
    },
    warn(message, context, err) {
      void emit('warn', scope, message, context, err);
    },
    error(message, context, err) {
      void emit('error', scope, message, context, err);
    },
  };
}

export const logger = createLogger('app');

export function initLogging() {
  if (loggingInitialized) {
    return;
  }

  loggingInitialized = true;

  if (isTauriRuntime() && import.meta.env.DEV) {
    void attachConsole().catch((err) => {
      console.error('[logger] Failed to attach webview console', err);
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      logger.error(
        'Unhandled window error',
        {
          source: event.filename,
          line: event.lineno,
          column: event.colno,
        },
        event.error ?? event.message,
      );
    });

    window.addEventListener('unhandledrejection', (event) => {
      logger.error('Unhandled promise rejection', undefined, event.reason);
    });
  }

  logger.info('Logging initialized', {
    runtime: isTauriRuntime() ? 'tauri' : 'web',
    mode: import.meta.env.MODE,
  });
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return stringifyValue(error);
}
