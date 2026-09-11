//! 浏览器自动化接缝(工单 08)main 进程侧:daemon 第一次驱动壳内页面。
//!
//! main 进程持有一条轻量 WS 客户端连接(既有 daemon 控制面通道
//! `/api/ws?token=<Local Daemon Token>`,仅回环),接收
//! `browser-automation-request` 事件,按 browserId 从 Browser Host guest
//! 登记表解析 <webview> webContents 后执行四种受控操作(eval / screenshot /
//! input / cdp),再把结果 POST 回 `/api/browser-automation/result`。
//!
//! 契约:
//! - 全部请求(含 CDP attach/detach)经全局 FIFO 队列串行执行,互不踩踏;
//! - eval 结果以 JSON 文本回传(与工单 07 渲染层 evaluate 契约一致:
//!   undefined → 'null',其余 JSON.stringify);
//! - screenshot 返回 base64 PNG 字符串;input 经 sendInputEvent 注入可信输入;
//! - cdp 幂等 attach 后 sendCommand,响应原样回传;
//! - browserId 找不到 / op 非法 / 执行抛错 → POST ok:false + error;
//! - 连接失败不崩溃:指数退避重连(降级为无自动化能力,仅 log);
//! - stop() 在 App 退出时调用,断开且不再重连。
//!
//! 本文件不 import electron(目标面以最小结构接口注入),便于纯 Node(vitest)契约测试。

import http from 'node:http';
import WebSocket from 'ws';

/** 四种受控自动化操作。 */
export type AutomationOp = 'eval' | 'screenshot' | 'input' | 'cdp';

/** automation 请求(daemon → 壳)的载荷形状。 */
export interface AutomationRequest {
  requestId: string;
  browserId?: string | null;
  op: string;
  params?: Record<string, unknown>;
}

/** 自动化目标页的最小结构面(Electron WebContents 的可测子集)。 */
export interface AutomationTarget {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  /** 参数为 Electron InputEvent 形状(mapInputParams 白名单产出);放宽为 object
   * 以兼容 WebContents 的 InputEvent 联合(接口无隐式索引签名)。 */
  sendInputEvent(event: object): void;
  debugger: {
    isAttached(): boolean;
    attach(): void;
    detach(): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

/** 一次自动化执行的终态(POST 回 daemon 的 result 载荷)。 */
export interface AutomationOutcome {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface BrowserAutomationDeps {
  /** 当前 daemon 端口(supervisor 出口;null 时本轮跳过,退避后重试)。 */
  getPort(): number | null;
  /** 读取 Local Daemon Token(文件缺失/为空返回 null)。 */
  readToken(): string | null;
  /** Browser Host guest 登记表:browserId → <webview> webContents。 */
  resolveTarget(browserId: string): AutomationTarget | undefined;
  /** 日志出口(缺省 console;测试注入断言)。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 重连退避基值(ms),指数翻倍,上限 10s;测试注入更小值。 */
  reconnectBaseDelayMs?: number;
}

export interface BrowserAutomationService {
  start(): void;
  /** App 退出时调用:断开连接并停止重连。 */
  stop(): void;
  isConnected(): boolean;
}

/** daemon 控制面事件信封:{"type":"event","sessionId":"","event":{...}}。 */
interface ControlEventEnvelope {
  type?: unknown;
  event?: unknown;
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') {
    console.error(`[browser-automation] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[browser-automation] ${message}`);
  } else {
    console.info(`[browser-automation] ${message}`);
  }
}

/** 与渲染层 electronBrowserHost 的 stringifyEvaluateResult 同形(工单 07 契约)。 */
export function stringifyEvaluateResult(result: unknown): string {
  if (result === undefined) return 'null';
  const text = JSON.stringify(result);
  return typeof text === 'string' ? text : 'null';
}

/** input 参数 → Electron sendInputEvent 事件(按 API 字段面白名单透传)。 */
export function mapInputParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = params ?? {};
  const event: Record<string, unknown> = { type: source.type };
  for (const key of ['x', 'y', 'button', 'clickCount', 'buttons', 'deltaX', 'deltaY', 'keyCode', 'char', 'modifiers'] as const) {
    if (source[key] !== undefined) {
      event[key] = source[key];
    }
  }
  return event;
}

export function parseAutomationRequest(raw: string): AutomationRequest | null {
  let envelope: ControlEventEnvelope;
  try {
    envelope = JSON.parse(raw) as ControlEventEnvelope;
  } catch {
    return null;
  }
  if (envelope?.type !== 'event') return null;
  const event = envelope.event as Record<string, unknown> | undefined;
  if (!event || event.type !== 'browser-automation-request') return null;
  const requestId = typeof event.requestId === 'string' ? event.requestId : '';
  if (!requestId) return null;
  return {
    requestId,
    browserId: typeof event.browserId === 'string' && event.browserId ? event.browserId : null,
    op: typeof event.op === 'string' ? event.op : '',
    params: (event.params ?? {}) as Record<string, unknown>,
  };
}

/**
 * 单次请求执行(不含队列):按 op 分发到目标页。失败以 {ok:false,error} 收口,
 * 不向上抛(调用方据此 POST result)。
 */
export async function executeAutomationRequest(
  deps: Pick<BrowserAutomationDeps, 'resolveTarget'>,
  request: AutomationRequest,
): Promise<AutomationOutcome> {
  const op = request.op;
  if (op !== 'eval' && op !== 'screenshot' && op !== 'input' && op !== 'cdp') {
    return { ok: false, error: `unknown automation op: ${op}` };
  }
  const target = request.browserId ? deps.resolveTarget(request.browserId) : undefined;
  if (!target) {
    return { ok: false, error: `browser not found: ${request.browserId ?? '(none)'}` };
  }
  const params = request.params ?? {};
  try {
    switch (op) {
      case 'eval': {
        const code = typeof params.code === 'string' ? params.code : '';
        if (!code) {
          return { ok: false, error: 'eval requires params.code' };
        }
        const result = await target.executeJavaScript(code);
        return { ok: true, payload: stringifyEvaluateResult(result) };
      }
      case 'screenshot': {
        const image = await target.capturePage();
        return { ok: true, payload: image.toPNG().toString('base64') };
      }
      case 'input': {
        target.sendInputEvent(mapInputParams(params));
        return { ok: true, payload: null };
      }
      case 'cdp': {
        const method = typeof params.method === 'string' ? params.method : '';
        if (!method) {
          return { ok: false, error: 'cdp requires params.method' };
        }
        const debugger_ = target.debugger;
        // 幂等 attach:已附挂则复用既有会话(attach/detach 均在队列内串行)。
        if (!debugger_.isAttached()) {
          debugger_.attach();
        }
        const cdpParams = (params.params ?? undefined) as Record<string, unknown> | undefined;
        const response = await debugger_.sendCommand(method, cdpParams);
        return { ok: true, payload: response ?? null };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** POST /api/browser-automation/result(带 Local Daemon Token,回环)。尽力而为。 */
export function postAutomationResult(
  deps: Pick<BrowserAutomationDeps, 'getPort' | 'readToken' | 'log'>,
  requestId: string,
  outcome: AutomationOutcome,
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const port = deps.getPort();
  const token = deps.readToken();
  if (!port || !token) {
    log('warn', `daemon 未就绪,丢弃 requestId=${requestId} 的回包`);
    return Promise.resolve();
  }
  const body = JSON.stringify({
    requestId,
    ok: outcome.ok,
    payload: outcome.payload ?? null,
    error: outcome.error,
  });
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/browser-automation/result',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'content-length': Buffer.byteLength(body),
        },
        timeout: 5_000,
      },
      (response) => {
        response.resume();
        resolve();
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve();
    });
    request.on('error', (error) => {
      log('warn', `result 回包失败(requestId=${requestId}): ${error.message}`);
      resolve();
    });
    request.end(body);
  });
}

/** 创建 main 进程自动化服务:WS 连接 + 全局 FIFO 队列 + result 回包。 */
export function createBrowserAutomationService(deps: BrowserAutomationDeps): BrowserAutomationService {
  const log = deps.log ?? defaultLog;
  const baseDelay = deps.reconnectBaseDelayMs ?? 500;
  const maxDelay = 10_000;

  let socket: WebSocket | null = null;
  let stopped = true;
  let connected = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /** 全局 FIFO:每条请求串在队尾(执行完才轮到下一条,含 CDP)。 */
  let queueTail: Promise<void> = Promise.resolve();

  function enqueue(request: AutomationRequest): void {
    queueTail = queueTail
      .then(async () => {
        const outcome = await executeAutomationRequest(deps, request);
        await postAutomationResult(deps, request.requestId, outcome);
      })
      .catch((error: unknown) => {
        // 队列永不带毒:单条失败(含回包异常)只记日志。
        log('error', `requestId=${request.requestId} 执行链异常: ${String(error)}`);
      });
  }

  function handleMessage(raw: string): void {
    const request = parseAutomationRequest(raw);
    if (!request) return;
    enqueue(request);
  }

  function scheduleConnect(delayMs: number): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(baseDelay * 2 ** reconnectAttempt, maxDelay);
    reconnectAttempt += 1;
    scheduleConnect(delay);
  }

  function connect(): void {
    if (stopped) return;
    const port = deps.getPort();
    const token = deps.readToken();
    if (!port || !token) {
      // daemon 未就绪 / token 未落盘:退避重试(不崩溃,降级无自动化能力)。
      scheduleReconnect();
      return;
    }
    const next = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
    socket = next;
    next.on('open', () => {
      if (socket !== next) return;
      connected = true;
      reconnectAttempt = 0;
      log('info', `已连接 daemon 控制面(127.0.0.1:${port}/api/ws)`);
    });
    next.on('message', (data: unknown) => {
      try {
        handleMessage(String(data));
      } catch (error) {
        log('warn', `automation 消息处理异常: ${String(error)}`);
      }
    });
    next.on('error', (error: Error) => {
      if (socket === next) {
        log('warn', `daemon 控制面连接错误: ${error.message}`);
      }
    });
    next.on('close', () => {
      if (socket !== next) return;
      socket = null;
      connected = false;
      // 主动 stop 的 close 不重连(stopped 已置位)。
      scheduleReconnect();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      reconnectAttempt = 0;
      scheduleConnect(0);
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = socket;
      socket = null;
      connected = false;
      if (current) {
        try {
          current.close();
        } catch {
          // ignore
        }
      }
    },
    isConnected: () => connected,
  };
}
