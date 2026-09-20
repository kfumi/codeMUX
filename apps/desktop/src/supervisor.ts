//! 壳侧 daemon supervisor 的 TypeScript 实现(工单 05)。
//!
//! 与 Tauri 壳时代的 Rust supervisor(已随工单 04/09 退役)同一套契约:
//! - run-state 发现文件 `<appDataDir>/daemon-run-state.json`
//!   `{ port, pid, version, managed_by, started_at }`(与 Rust 结构体同形,snake_case 键);
//! - 回环健康探活 GET /api/health(2s 超时);
//! - 决策表:无 run-state → spawned;健康且版本匹配 → attached(不持 child,
//!   壳退出后外部 daemon 存活);版本不匹配或不健康 → restarted(强杀旧 pid →
//!   清 run-state → spawn 新 daemon);
//! - 只有本 supervisor spawn 的 child 会被 stopManaged 停止;
//! - 意外退出 → 清 run-state 并向 onEvent 发 `{status:'exited'}`。
//!
//! 本文件不 import electron,便于在纯 Node(vitest)下做契约测试。

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';import {
  mkdirSync,
  openSync,
  closeSync,
  existsSync,
  readFileSync,
  rmSync,
  appendFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { formatLocalTimestamp } from './log-format';

/** 与 Rust `DaemonRunState` 同形的 run-state 条目(serde 无 rename → snake_case 键)。 */
export interface DaemonRunState {
  port: number;
  pid: number;
  version: string;
  managed_by: string;
  started_at: string;
}

export const RUN_STATE_FILE = 'daemon-run-state.json';

/** /api/health 响应中 supervisor 关心的字段。 */
export interface DaemonHealth {
  ok: boolean;
  version: string;
}

/** supervisor 发给壳的生命周期事件(与 Tauri `daemon-lifecycle` 载荷一致)。 */
export interface DaemonLifecycleEvent {
  status: 'started' | 'exited' | 'start-failed';
  decision?: EnsureDecision;
  error?: string;
}

export type EnsureDecision = 'attached' | 'spawned' | 'restarted';

export interface DaemonStatus {
  running: boolean;
  port: number | null;
  version: string | null;
  managedBy: string | null;
  managed: boolean;
  decision?: string;
}

/** 就绪/探活/巡检节奏(与 Rust 版常量一致;测试可注入更短超时)。 */
export interface SupervisorTimeouts {
  readyTimeoutMs: number;
  healthTimeoutMs: number;
  readyPollIntervalMs: number;
}

const DEFAULT_TIMEOUTS: SupervisorTimeouts = {
  readyTimeoutMs: 30_000,
  healthTimeoutMs: 2_000,
  readyPollIntervalMs: 200,
};

export interface SupervisorOptions {
  appDataDir: string;
  /** daemon 可执行文件绝对路径。 */
  exePath: string;
  /**
   * 追加在旗标之前的参数(生产为空;契约测试用 `node fake-daemon.mjs`
   * 扮演 daemon 时注入脚本路径)。
   */
  exeArgs?: string[];
  /** 打包资源根(supervisor 会向 daemon 传 --resource-dir);开发态传 null。 */
  resourceDir?: string | null;
  /** 托管标记,与 Tauri 壳一致使用 "desktop"。 */
  managedBy?: string;
  /** 壳期望的 daemon 版本;缺省回退环境变量 CODEMUX_EXPECTED_DAEMON_VERSION,未设置则放行任意版本。 */
  expectedDaemonVersion?: string | null;
  /** 生命周期事件出口(壳转发给渲染层)。 */
  onEvent?: (event: DaemonLifecycleEvent) => void;
  timeouts?: Partial<SupervisorTimeouts>;
}

export interface Supervisor {
  ensureDaemon(): Promise<EnsureDecision>;
  restart(): Promise<DaemonStatus>;
  stopManaged(): Promise<void>;
  daemonStatus(): Promise<DaemonStatus>;
  /** 当前已发现的 daemon 端口(渲染层 bootstrap 用)。 */
  getPort(): number | null;
  /** 停止巡检(应用退出前调用;不负责 stopManaged)。 */
  dispose(): void;
}

function nowLocalTimestamp(): string {
  return formatLocalTimestamp(new Date());
}

function runStatePath(appDataDir: string): string {
  return path.join(appDataDir, RUN_STATE_FILE);
}

/**
 * 进程存活探测:对齐 run_state.rs 的语义 —— `process.kill(pid, 0)` 成功即存活;
 * EPERM(进程存在但无权限发信号)视为存活;ESRCH 等其它错误视为已死。
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读取仍存活的 run-state:文件缺失、解析失败或 pid 已死一律视为 stale(对齐 Rust read)。 */
export function readRunState(appDataDir: string): DaemonRunState | null {
  let raw: string;
  try {
    raw = readFileSync(runStatePath(appDataDir), 'utf8');
  } catch {
    return null;
  }
  let state: DaemonRunState;
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonRunState>;
    if (
      typeof parsed.port !== 'number'
      || typeof parsed.pid !== 'number'
      || typeof parsed.version !== 'string'
    ) {
      return null;
    }
    state = {
      port: parsed.port,
      pid: parsed.pid,
      version: parsed.version,
      managed_by: typeof parsed.managed_by === 'string' ? parsed.managed_by : 'standalone',
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : '',
    };
  } catch {
    return null;
  }
  if (!pidIsAlive(state.pid)) {
    return null;
  }
  return state;
}

/** 清 run-state:尽力而为,静默失败(对齐 Rust clear)。 */
export function clearRunState(appDataDir: string): void {
  try {
    rmSync(runStatePath(appDataDir), { force: true });
  } catch {
    // ignore
  }
}

/**
 * 回环健康探活:GET http://127.0.0.1:<port>/api/health,超时默认 2s,
 * 解析 JSON;任何一步失败返回 null(视为不可用)。
 */
export function probeDaemonHealth(
  port: number,
  timeoutMs = DEFAULT_TIMEOUTS.healthTimeoutMs,
): Promise<DaemonHealth | null> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: DaemonHealth | null) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const start = body.indexOf('{');
            if (start < 0) {
              finish(null);
              return;
            }
            const health = JSON.parse(body.slice(start)) as Partial<DaemonHealth>;
            if (typeof health.ok !== 'boolean' || typeof health.version !== 'string') {
              finish(null);
              return;
            }
            finish({ ok: health.ok, version: health.version });
          } catch {
            finish(null);
          }
        });
        response.on('error', () => finish(null));
      },
    );
    request.on('timeout', () => finish(null));
    request.on('error', () => finish(null));
  });
}

/** child 是否已退出(try_wait 的 Node 等价:exitCode/signalCode 就绪)。 */
function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTimeouts(timeouts?: Partial<SupervisorTimeouts>): SupervisorTimeouts {
  return { ...DEFAULT_TIMEOUTS, ...timeouts };
}

/**
 * 创建 supervisor。字段不可省:必须显式给 appDataDir / exePath(对齐 Rust
 * SupervisorState::new 的显式构造约束)。
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const timeouts = resolveTimeouts(options.timeouts);
  const managedBy = options.managedBy ?? 'desktop';
  const appDataDir = options.appDataDir;
  const emit = (event: DaemonLifecycleEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // 事件出口异常不反噬 supervisor。
    }
  };

  let child: ChildProcess | null = null;
  let childPid: number | null = null;
  let port: number | null = null;
  /** 主动 stop 期间置位:watcher 据此区分「我们杀的」与「意外退出」。 */
  let stopping = false;
  let disposed = false;

  function watchChild(target: ChildProcess): void {
    target.on('exit', () => {
      // 只处理仍是当前托管 child 的退出(restart 换上的新 child 继续被守望)。
      if (child !== target) return;
      child = null;
      childPid = null;
      if (stopping) {
        // 主动 stop/restart 杀掉的:预期退出,不惊扰前端(stopManaged 负责清 run-state)。
        return;
      }
      // 意外崩溃:清 run-state 并通知前端(对齐 Rust watch_managed)。
      clearRunState(appDataDir);
      port = null;
      emit({ status: 'exited' });
    });
  }

  /**
   * spawn 独立 daemon:stdout/stderr 追加重定向到 `<appDataDir>/logs/daemon.log`,
   * 轮询 run-state 直到出现本 child 的条目且健康探活通过(对齐 Rust spawn_managed_daemon)。
   */
  async function spawnManagedDaemon(): Promise<void> {
    mkdirSync(appDataDir, { recursive: true });
    const logDir = path.join(appDataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'daemon.log');
    // append 语义(Rust 版以 append fd 打开);启动时追加一行分隔便于排障。
    appendFileSync(logPath, `\n[shell] spawning daemon (${nowLocalTimestamp()})\n`);
    const logFd = openSync(logPath, 'a');
    try {
      const args = [...(options.exeArgs ?? []), '--app-data-dir', appDataDir, '--managed-by', managedBy];
      if (options.resourceDir && existsSync(options.resourceDir)) {
        args.push('--resource-dir', options.resourceDir);
      }
      const spawned = nodeSpawn(options.exePath, args, {
        // Windows CREATE_NO_WINDOW 等价:不弹控制台窗口;
        // detached:false → daemon 不脱离壳进程组,由 stopManaged 强杀收尾。
        windowsHide: true,
        detached: false,
        // stdout/stderr 追加重定向到同一个日志文件(对齐 Rust 的 Stdio::from(log))。
        stdio: ['ignore', logFd, logFd],
      });
      spawned.on('error', () => {
        /* spawn 失败通过就绪轮询的 exit/超时路径上报 */
      });
      child = spawned;
      childPid = spawned.pid ?? null;
      watchChild(spawned);
    } catch (error) {
      closeSync(logFd);
      throw new Error(`Failed to spawn daemon (${options.exePath}): ${String(error)}`);
    }

    if (!child) {
      closeSync(logFd);
      throw new Error(`Failed to spawn daemon (${options.exePath})`);
    }

    const deadline = Date.now() + timeouts.readyTimeoutMs;
    const currentChild = child;
    while (true) {
      if (childExited(currentChild)) {
        child = null;
        childPid = null;
        closeSync(logFd);
        const reason = currentChild.exitCode !== null ? `exit code ${currentChild.exitCode}` : `signal ${currentChild.signalCode}`;
        throw new Error(`daemon exited during startup: ${reason}`);
      }
      const runState = readRunState(appDataDir);
      if (runState && runState.pid === (currentChild.pid ?? -1)) {
        const health = await probeDaemonHealth(runState.port, timeouts.healthTimeoutMs);
        if (health?.ok) {
          port = runState.port;
          stopping = false;
          closeSync(logFd);
          return;
        }
        // run-state 已写但探活未过:继续轮询直到超时。
      }
      if (Date.now() >= deadline) {
        try {
          currentChild.kill();
        } catch {
          // ignore
        }
        child = null;
        childPid = null;
        closeSync(logFd);
        throw new Error(`daemon did not become ready within ${Math.round(timeouts.readyTimeoutMs / 1000)}s`);
      }
      await sleep(timeouts.readyPollIntervalMs);
    }
  }

  /**
   * 强杀 daemon 及其整棵子进程树(sidecar 一并收尾):Windows 用
   * taskkill /F /T;unix 仅 SIGKILL daemon 本体(sidecar 由 init 收养,
   * unix 树收尾待办)。resolve pid 的存活探测保持 run_state 同语义。
   */
  function killDaemonTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        nodeSpawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  /**
   * 强杀旧 daemon:优先我们持有的 child 句柄(先摘除引用再整树强杀,并等退出 ——
   * 对齐 Rust kill_old_daemon 的 child.kill()+child.wait(),避免旧进程仍占端口),
   * 否则按 pid 系统强杀。
   */
  async function killOldDaemon(runState: DaemonRunState): Promise<void> {
    const managed = child;
    if (managed) {
      // 先摘除引用:watchChild 的守卫(child !== target)保证这次主动击杀
      // 不会被当成意外退出上报。
      child = null;
      childPid = null;
      const exited = new Promise<void>((resolve) => {
        if (childExited(managed)) {
          resolve();
          return;
        }
        const onExit = () => {
          managed.off('exit', onExit);
          resolve();
        };
        managed.on('exit', onExit);
      });
      killDaemonTree(managed.pid ?? runState.pid);
      await exited;
      return;
    }
    killDaemonTree(runState.pid);
  }

  /** Restarted 路径:强杀旧 daemon(等退出)→ 清 run-state → spawn 新 daemon。 */
  async function restartManaged(runState: DaemonRunState): Promise<EnsureDecision> {
    await killOldDaemon(runState);
    clearRunState(appDataDir);
    // 等一拍,避免旧进程端口尚未释放(Windows TIME_WAIT/TCP 重绑竞争)。
    await sleep(100);
    await spawnManagedDaemon();
    const decision: EnsureDecision = 'restarted';
    emit({ status: 'started', decision });
    return decision;
  }

  async function ensureDaemon(): Promise<EnsureDecision> {
    if (disposed) throw new Error('supervisor disposed');
    const runState = readRunState(appDataDir);
    if (runState) {
      const expected = options.expectedDaemonVersion
        ?? process.env.CODEMUX_EXPECTED_DAEMON_VERSION
        ?? null;
      const versionMatches = expected === null || expected === runState.version;
      if (versionMatches) {
        const health = await probeDaemonHealth(runState.port, timeouts.healthTimeoutMs);
        if (health?.ok) {
          // attach:复用已有 daemon,不持 child(壳退出后外部 daemon 存活)。
          port = runState.port;
          const decision: EnsureDecision = 'attached';
          emit({ status: 'started', decision });
          return decision;
        }
      }
      return restartManaged(runState);
    }
    await spawnManagedDaemon();
    const decision: EnsureDecision = 'spawned';
    emit({ status: 'started', decision });
    return decision;
  }

  /** 停掉壳托管的 daemon:强杀 → 等退出 → 清 run-state。attach 的外部 daemon 绝不动。 */
  async function stopManaged(): Promise<void> {
    if (!child) {
      return;
    }
    stopping = true;
    const target = child;
    const exited = new Promise<void>((resolve) => {
      const onExit = () => {
        target.off('exit', onExit);
        resolve();
      };
      target.on('exit', onExit);
    });
    try {
      // 对齐 Rust Child::kill:stop/restart 都是强杀,且整树收尾(含 sidecar)。
      const targetPid = childPid;
      if (targetPid !== null) {
        killDaemonTree(targetPid);
      }
    } catch {
      // ignore
    }
    await exited;
    child = null;
    childPid = null;
    clearRunState(appDataDir);
    port = null;
    // 标记用完即复位:之后 restart→spawn 的新 child 崩溃仍要被当作意外上报。
    stopping = false;
  }

  async function daemonStatus(): Promise<DaemonStatus> {
    const runState = readRunState(appDataDir);
    const managed = child !== null;
    const statusPort = port ?? runState?.port ?? null;
    const health = statusPort !== null
      ? await probeDaemonHealth(statusPort, timeouts.healthTimeoutMs)
      : null;
    return {
      running: health?.ok ?? false,
      port: statusPort,
      version: health?.version ?? runState?.version ?? null,
      managedBy: runState?.managed_by ?? null,
      managed,
    };
  }

  async function restart(): Promise<DaemonStatus> {
    await stopManaged();
    const decision = await ensureDaemon();
    const status = await daemonStatus();
    return { ...status, decision };
  }

  function dispose(): void {
    disposed = true;
    // 'exit' 监听挂在 child 上,Node 进程退出时自然回收;这里仅阻断后续事件。
    child = null;
    childPid = null;
  }

  return {
    ensureDaemon,
    restart,
    stopManaged,
    daemonStatus,
    getPort: () => port,
    dispose,
  };
}

/** daemon 运行日志路径(与壳自身日志同目录,排障可见)。 */
export function daemonLogPath(appDataDir: string): string {
  return path.join(appDataDir, 'logs', 'daemon.log');
}
