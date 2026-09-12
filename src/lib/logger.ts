/**
 * 纯前端 logger(工单 09:Tauri 壳退役,原 plugin-log 通道移除)。
 *
 * - 输出统一走 console(Electron 渲染层 console 已由 main 进程聚合,
 *   打包态日志落盘由壳侧负责,渲染层不再做 IPC 转发)。
 * - 保留客户端级别门槛:高频流式事件期间避免低级别日志开销。
 */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// Client-side level gate: short-circuits low-level logs BEFORE formatting.
// During high-frequency streaming events this keeps debug/trace overhead near zero.
let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'info';

export function setMinLogLevel(level: LogLevel) {
  minLevel = level;
}

export function getMinLogLevel(): LogLevel {
  return minLevel;
}

type Logger = {
  trace: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext, err?: unknown) => void;
  error: (message: string, context?: LogContext, err?: unknown) => void;
};

let loggingInitialized = false;

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
  // context 必须内联进消息字符串:Electron main 的 console-message 事件
  // (renderer.log 落盘来源)只捕获首个参数文本,对象参数会变成 [object Object],
  // sessionId 等排查字段会全部丢失。
  const contextText = context ? ` ${JSON.stringify(context)}` : '';
  return [`[${scope}] ${message}${contextText}`];
}

function emit(level: LogLevel, scope: string, message: string, context?: LogContext, err?: unknown) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const payload = formatConsolePayload(scope, message, normalizeContext(context, err));
  switch (level) {
    case 'trace':
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
      emit('trace', scope, message, context);
    },
    debug(message, context) {
      emit('debug', scope, message, context);
    },
    info(message, context) {
      emit('info', scope, message, context);
    },
    warn(message, context, err) {
      emit('warn', scope, message, context, err);
    },
    error(message, context, err) {
      emit('error', scope, message, context, err);
    },
  };
}

export const logger = createLogger('app');

export function initLogging() {
  if (loggingInitialized) {
    return;
  }

  loggingInitialized = true;

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
    runtime: typeof window !== 'undefined' && (window as typeof window & { codemuxDesktop?: unknown }).codemuxDesktop
      ? 'electron'
      : 'web',
    mode: import.meta.env.MODE,
  });
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return stringifyValue(error);
}
