//! browser_open 的渲染层往返协调器(自举对,见 daemon `browser_automation.rs`)。
//!
//! main 收到 daemon 的 `open` op 后,自己开不了标签 —— 页面托管在渲染层
//! (`<webview>` + browserStore)。这里把「发给渲染层的开页请求」与「渲染层的
//! 回包」按 requestId 关联成一次可等待的调用:
//!
//! 1. `open(url)` 生成 requestId → `browser-agent-open` 事件发渲染层 → 挂起;
//! 2. 渲染层开好标签(或报错)后经 shell-bridge 通道回 `{requestId, browserId|error}`;
//! 3. 回包按时序落进 pending 表,迟到/未知 requestId 丢弃并记日志。
//!
//! 超时必须比 daemon 的 15s 等待窗短一截(这里 5s):渲染层正常在百毫秒级回包,
//! 超过它多半是界面没加载/不是 Electron 宿主,等下去只会把 daemon 的整段等待
//! 耗光。回包里只有 browserId;webview 的 did-attach 与 guest 登记由
//! browser-automation.ts 在拿到 browserId 之后统一轮询等待。
//!
//! 本文件不 import electron(发送与回包入口以依赖注入),便于纯 Node(vitest)测试。

/** 开页请求(main → 渲染层,`browser-agent-open` 事件载荷)。 */
export interface AgentOpenRequest {
  requestId: string;
  url: string;
}

/** 开页回包(渲染层 → main,shell-bridge `browserAgentOpenResult` 通道载荷)。 */
export interface AgentOpenResult {
  requestId: string;
  browserId?: string;
  error?: string;
}

/** `open(url)` 的终态:成功带 browserId,失败带面向模型的文案。 */
export type AgentOpenOutcome = { ok: true; browserId: string } | { ok: false; error: string };

export interface AgentOpenCoordinatorDeps {
  /** 发送开页事件;返回 false = 没有可用的主窗口(渲染层宿主不在这台面上)。 */
  sendOpenRequest(request: AgentOpenRequest): boolean;
  /** 渲染层回包等待上限(ms);缺省 5000。 */
  replyTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** 渲染层回包的缺省等待上限:daemon 等 15s,这里留足壳侧 guest 轮询的余量。 */
export const AGENT_OPEN_REPLY_TIMEOUT_MS = 5_000;

interface PendingEntry {
  resolve: (outcome: AgentOpenOutcome) => void;
  timer: NodeJS.Timeout;
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[browser-agent-open] ${message}`);
  else if (level === 'warn') console.warn(`[browser-agent-open] ${message}`);
  else console.info(`[browser-agent-open] ${message}`);
}

export interface AgentOpenCoordinator {
  /** 发起一次开页并等渲染层回包(受 replyTimeoutMs 约束)。 */
  open(url: string): Promise<AgentOpenOutcome>;
  /** 渲染层回包入口(形状非法按未知 requestId 处理,返回 false)。 */
  submitResult(raw: unknown): boolean;
  dispose(): void;
}

export function createAgentOpenCoordinator(deps: AgentOpenCoordinatorDeps): AgentOpenCoordinator {
  const log = deps.log ?? defaultLog;
  const replyTimeoutMs = deps.replyTimeoutMs ?? AGENT_OPEN_REPLY_TIMEOUT_MS;
  const pending = new Map<string, PendingEntry>();

  function settle(requestId: string, outcome: AgentOpenOutcome): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  return {
    open(url: string): Promise<AgentOpenOutcome> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const entry: PendingEntry = {
          resolve,
          timer: setTimeout(() => {
            settle(
              requestId,
              { ok: false, error: `等待内置浏览器界面响应开页超时(${replyTimeoutMs}ms)` },
            );
          }, replyTimeoutMs),
        };
        pending.set(requestId, entry);
        const sent = deps.sendOpenRequest({ requestId, url });
        if (!sent) {
          settle(
            requestId,
            { ok: false, error: '内置浏览器宿主不可用(桌面壳主窗口未就绪):无法开页,请让用户打开应用后重试' },
          );
        }
      });
    },

    submitResult(raw: unknown): boolean {
      if (typeof raw !== 'object' || raw === null) return false;
      const record = raw as { requestId?: unknown; browserId?: unknown; error?: unknown };
      if (typeof record.requestId !== 'string' || !record.requestId) return false;
      if (!pending.has(record.requestId)) {
        log('warn', `收到未知/迟到的开页回包 requestId=${record.requestId}`);
        return false;
      }
      if (typeof record.browserId === 'string' && record.browserId) {
        settle(record.requestId, { ok: true, browserId: record.browserId });
        return true;
      }
      settle(
        record.requestId,
        {
          ok: false,
          error: typeof record.error === 'string' && record.error
            ? record.error
            : '内置浏览器界面开页失败(未给出原因)',
        },
      );
      return true;
    },

    dispose(): void {
      for (const [requestId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: '开页协调器已关闭' });
        pending.delete(requestId);
      }
    },
  };
}
