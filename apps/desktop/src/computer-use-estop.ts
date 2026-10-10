//! 壳侧急停出口(工单 03):全局 Esc 收尾动作的那**一次 daemon 调用**。
//!
//! 与只停机器的 `/api/computer-use/driver/estop` 不同,这里的语义是「停干净」:一次请求
//! 让 daemon 杀掉驱动子进程、收回该会话的限时授权、打断有活动的回合(工单 02 的
//! `/api/computer-use/estop`)。它不依赖渲染层回话 —— 没人开界面时那半条路本来就不存在。
//!
//! 旧 daemon(02 之前没有这个端点)退回旧路径:先通知渲染层打断回合,再杀驱动子进程。
//! 端点是新增的,404 是唯一判据;其它错误照原样抛出(调用方只记日志,没有第二条路可退)。
//!
//! 本文件不 import electron,便于 Node(vitest)契约测试。

/** 「停干净」端点(工单 02 新增)。 */
export const COMPUTER_USE_ESTOP_PATH = '/api/computer-use/estop';
/** 只停机器的旧端点(旧 daemon 的兜底)。 */
export const COMPUTER_USE_DRIVER_ESTOP_PATH = '/api/computer-use/driver/estop';

/** 壳直连 daemon 拿到的非 2xx(带状态码:急停按「端点不存在」判断要不要退回旧路径)。 */
export class DaemonHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`daemon 返回 ${statusCode}`);
    this.name = 'DaemonHttpError';
    this.statusCode = statusCode;
  }
}

export type EstopLogLevel = 'info' | 'warn' | 'error';

export interface EstopEndpointDeps {
  /** JSON POST(非 2xx 以 `DaemonHttpError` 抛出,带状态码)。 */
  post(path: string, body: Record<string, unknown>): Promise<void>;
  /** 旧 daemon 的兜底路径:通知渲染层打断当前回合。 */
  notifyRenderer(): void;
  log?(level: EstopLogLevel, message: string): void;
}

export interface EstopEndpoint {
  /** 全局 Esc 触发时调用;失败原样抛出,由调用方记日志。 */
  estopEverything(): Promise<void>;
}

function defaultLog(level: EstopLogLevel, message: string): void {
  if (level === 'error') {
    console.error(`[computer-use-estop] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[computer-use-estop] ${message}`);
  } else {
    console.log(`[computer-use-estop] ${message}`);
  }
}

export function createEstopEndpoint(deps: EstopEndpointDeps): EstopEndpoint {
  const log = deps.log ?? defaultLog;
  return {
    async estopEverything(): Promise<void> {
      try {
        await deps.post(COMPUTER_USE_ESTOP_PATH, {});
        return;
      } catch (error) {
        if (!(error instanceof DaemonHttpError) || error.statusCode !== 404) {
          throw error;
        }
      }
      // 旧 daemon:它只有旧端点。先把「回合被打断」这个事实交给界面(旧行为),再杀驱动。
      log('warn', `daemon 无 ${COMPUTER_USE_ESTOP_PATH}(旧版本):退回 driver/estop + 渲染层通知`);
      try {
        deps.notifyRenderer();
      } catch (error) {
        // 通知失败不该拦住杀驱动 —— 停机器比通知界面更要紧。
        log('error', `通知渲染层失败: ${String(error)}`);
      }
      await deps.post(COMPUTER_USE_DRIVER_ESTOP_PATH, {});
    },
  };
}
