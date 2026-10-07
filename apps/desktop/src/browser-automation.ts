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

import { parseDesktopUiEvent } from './desktop-events';
import {
  activeDesktopWindow,
  captureDesktop,
  listDesktopSources,
  type DesktopCaptureDeps,
} from './desktop-capture';

/** 受控自动化操作(浏览器级 + 桌面只读观测,工单 04)。 */
export type AutomationOp =
  | 'eval' | 'screenshot' | 'input' | 'cdp' | 'snapshot' | 'click' | 'type' | 'scroll' | 'select'
  | 'desktop-windows' | 'desktop-screenshot' | 'desktop-active-window';

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

/** list 操作返回的存活 guest 条目(与 BrowserGuestTracker.list 同形)。 */
export interface AutomationTargetInfo {
  browserId: string;
  url: string;
  title: string;
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
  /** 最近登记且存活的 guest(请求省略 browserId 时的默认目标;缺省视为无目标)。 */
  resolveMostRecent?(): AutomationTarget | undefined;
  /** 全部存活 guest 清单(list 操作)。 */
  listTargets(): AutomationTargetInfo[];
  /** 日志出口(缺省 console;测试注入断言)。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 重连退避基值(ms),指数翻倍,上限 10s;测试注入更小值。 */
  reconnectBaseDelayMs?: number;
  /**
   * 桌面 UI 事件出口(工单 09):daemon 经控制面 WS 广播的 ui-event 帧
   * (sessions-changed / scheduled-tasks-changed / runtime-install-progress*)
   * 以同名事件名转发渲染层(main 用 webContents.send)。缺省不转发。
   */
  onUiEvent?: (name: string, payload: unknown) => void;
  /**
   * 桌面只读观测(工单 04):窗口清单/截图/活动窗口。缺省表示该宿主没有
   * 桌面捕获能力(纯浏览器形态),桌面 op 明确报错而不是静默失败。
   */
  desktop?: DesktopCaptureDeps;
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
/** 快照元素：一次 snapshot 的编号行，可被后续 click/type/scroll/select 引用 */
export interface SnapshotElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SnapshotElement {
  id: string;
  tag: string;
  role: string;
  name: string;
  bounds: SnapshotElementBounds;
  /**
   * 密码框标记(工单 03 敏感判定用):daemon 据此强制人工确认,不允许
   * 「本会话记住」。壳只报标记,不读值。
   */
  sensitive?: boolean;
}
/** snapshot 回填 payload 的形状 */
export interface SnapshotPayload {
  elements: SnapshotElement[];
  viewport: { width: number; height: number };
  screenshot: string;
  /** 页面 URL 与标题(审批敏感判定:登录/支付页整页都要人确认)。 */
  url: string;
  title: string;
}
/** 元素快照缓存：snapshot 写入，元素操作按同一键读取；全局 FIFO 串行保证先后序 */
const snapshotCaches = new Map<string, SnapshotElement[]>();
/** 快照缓存键：与目标解析规则对齐（显式 browserId，否则最近页面） */
function snapshotCacheKey(browserId: string | null | undefined): string {
  return browserId ? browserId : '__recent__';
}
/** 测试与诊断用：清空元素快照缓存 */
export function clearSnapshotCaches(): void {
  snapshotCaches.clear();
}
/** 页面内枚举可交互元素的脚本（返回元素数组与视口，元素按出现顺序编号） */
const SNAPSHOT_ENUMERATE_SCRIPT = `(() => {
  const found = [];
  const selector = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[contenteditable]';
  let index = 0;
  const nodes = document.querySelectorAll(selector);
  for (const el of nodes) {
    if (index >= 200) { break; }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { continue; }
    const raw = el.getAttribute('aria-label') || el.textContent || '';
    const label = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
    const sensitive = el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password';
    index += 1;
    found.push({ id: 'e' + index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: label, sensitive, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
  }
  return { elements: found, viewport: { width: window.innerWidth, height: window.innerHeight }, url: location.href, title: document.title };
})()`;


/** 执行 snapshot：页内枚举 + 截图 + 写缓存 */
async function executeSnapshot(target: AutomationTarget, cacheKey: string): Promise<AutomationOutcome> {
  let enumerated: unknown;
  try {
    enumerated = await target.executeJavaScript(SNAPSHOT_ENUMERATE_SCRIPT);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const record = enumerated as { elements?: unknown; viewport?: unknown; url?: unknown; title?: unknown } | null | undefined;
  const elements = Array.isArray(record?.elements) ? (record?.elements as SnapshotElement[]) : null;
  if (!elements) {
    return { ok: false, error: 'snapshot：页面未返回元素列表' };
  }
  snapshotCaches.set(cacheKey, elements);
  try {
    const image = await target.capturePage();
    const viewport = (record?.viewport as { width: number; height: number } | undefined) ?? { width: 0, height: 0 };
    const pageRecord = record as { url?: unknown; title?: unknown } | null | undefined;
    const payload: SnapshotPayload = {
      elements,
      viewport,
      screenshot: image.toPNG().toString('base64'),
      url: typeof pageRecord?.url === 'string' ? pageRecord.url : '',
      title: typeof pageRecord?.title === 'string' ? pageRecord.title : '',
    };
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
/** 按缓存键解析元素编号；未命中交由调用方提示重新快照 */
function resolveSnapshotElement(cacheKey: string, elementId: string): SnapshotElement | undefined {
  return snapshotCaches.get(cacheKey)?.find((item) => item.id === elementId);
}
function unknownElementError(elementId: string): AutomationOutcome {
  return { ok: false, error: 'unknown elementId: ' + elementId + '（先调 snapshot 拿最新元素列表）' };
}
/** 在元素中心点按下弹起（附带一次移动以保证悬停状态正确） */
function clickElementCenter(target: AutomationTarget, element: SnapshotElement, button: string): void {
  const x = Math.round(element.bounds.x + element.bounds.width / 2);
  const y = Math.round(element.bounds.y + element.bounds.height / 2);
  target.sendInputEvent({ type: 'mouseMove', x, y });
  target.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  target.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
}

/** 构造输入脚本：聚焦元素设值并派发 input/change；submit 为真且在表单内则提交 */
function buildTypeScript(text: string, submit: boolean): string {
  const value = JSON.stringify(text);
  const quote = (name: string): string => JSON.stringify(name);
  const submitStep = submit ? 'var __form = el.form;if(__form && __form.requestSubmit){__form.requestSubmit();}' : '';
  return '(function(){var el = document.activeElement;'
    + 'if(!el){throw new Error(' + quote('no focused element') + ');}'
    + 'el.focus();'
    + 'if(' + quote('value') + ' in el){el.value = ' + value + ';}else{el.textContent = ' + value + ';}'
    + 'el.dispatchEvent(new Event(' + quote('input') + ',{bubbles:true}));'
    + 'el.dispatchEvent(new Event(' + quote('change') + ',{bubbles:true}));'
    + submitStep + '})()';
}
/** 构造下拉选择脚本：聚焦元素必须是 select，设值后派发 change */
function buildSelectScript(value: string): string {
  const quote = (name: string): string => JSON.stringify(name);
  return '(function(){var el = document.activeElement;'
    + 'if(!el||el.tagName.toLowerCase()!==' + quote('select') + '){throw new Error(' + quote('focused element is not a select') + ');}'
    + 'el.value = ' + JSON.stringify(value) + ';'
    + 'el.dispatchEvent(new Event(' + quote('change') + ',{bubbles:true}));})()';
}

/** 元素级操作分发（click/type/scroll/select）；无元素 scroll 走整页滚屏 */
async function executeElementOp(target: AutomationTarget, cacheKey: string, op: string, params: Record<string, unknown>): Promise<AutomationOutcome> {
  if (op === 'scroll' && params.elementId === undefined) {
    const deltaX = typeof params.deltaX === 'number' ? (params.deltaX as number) : 0;
    const deltaY = typeof params.deltaY === 'number' ? (params.deltaY as number) : 0;
    try {
      await target.executeJavaScript('window.scrollBy(' + deltaX + ', ' + deltaY + ')');
      return { ok: true, payload: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const elementId = typeof params.elementId === 'string' ? params.elementId : '';
  if (!elementId) {
    return { ok: false, error: op + ' requires params.elementId' };
  }
  const element = resolveSnapshotElement(cacheKey, elementId);
  if (!element) {
    return unknownElementError(elementId);
  }
  const button = typeof params.button === 'string' ? params.button : 'left';
  try {
    switch (op) {
      case 'click': {
        clickElementCenter(target, element, button);
        return { ok: true, payload: null };
      }
      case 'type': {
        const text = typeof params.text === 'string' ? params.text : '';
        if (!text) {
          return { ok: false, error: 'type requires params.text' };
        }
        clickElementCenter(target, element, button);
        await target.executeJavaScript(buildTypeScript(text, params.submit === true));
        return { ok: true, payload: null };
      }
      case 'scroll': {
        const deltaX = typeof params.deltaX === 'number' ? (params.deltaX as number) : 0;
        const deltaY = typeof params.deltaY === 'number' ? (params.deltaY as number) : 0;
        const x = Math.round(element.bounds.x + element.bounds.width / 2);
        const y = Math.round(element.bounds.y + element.bounds.height / 2);
        target.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
        return { ok: true, payload: null };
      }
      case 'select': {
        const value = typeof params.value === 'string' ? params.value : '';
        if (!value) {
          return { ok: false, error: 'select requires params.value' };
        }
        clickElementCenter(target, element, button);
        await target.executeJavaScript(buildSelectScript(value));
        return { ok: true, payload: null };
      }
      default: {
        return { ok: false, error: 'unknown element op: ' + op };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeAutomationRequest(
  deps: Pick<BrowserAutomationDeps, 'resolveTarget' | 'resolveMostRecent' | 'listTargets' | 'desktop'>,
  request: AutomationRequest,
): Promise<AutomationOutcome> {
  const op = request.op;
  if (op !== 'eval' && op !== 'screenshot' && op !== 'input' && op !== 'cdp' && op !== 'snapshot' && op !== 'click' && op !== 'type' && op !== 'scroll' && op !== 'select' && op !== 'list'
    && op !== 'desktop-windows' && op !== 'desktop-screenshot' && op !== 'desktop-active-window') {
    return { ok: false, error: `unknown automation op: ${op}` };
  }
  // 桌面只读观测(工单 04):不碰页面,走独立的捕获依赖面。
  if (op === 'desktop-windows' || op === 'desktop-screenshot' || op === 'desktop-active-window') {
    if (!deps.desktop) {
      return { ok: false, error: '当前宿主不支持桌面截图(需要桌面壳)' };
    }
    try {
      if (op === 'desktop-windows') {
        return { ok: true, payload: await listDesktopSources(deps.desktop) };
      }
      if (op === 'desktop-screenshot') {
        return await captureDesktop(deps.desktop, request.params ?? {});
      }
      return await activeDesktopWindow(deps.desktop);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  // list 不需要目标页:直接报存活 guest 清单。
  if (op === 'list') {
    return { ok: true, payload: deps.listTargets() };
  }
  const target = request.browserId
    ? deps.resolveTarget(request.browserId)
    : deps.resolveMostRecent?.();
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
      case 'snapshot': {
        return executeSnapshot(target, snapshotCacheKey(request.browserId));
      }
      case 'click':
      case 'type':
      case 'scroll':
      case 'select': {
        return executeElementOp(target, snapshotCacheKey(request.browserId), op, params);
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
    if (request) {
      enqueue(request);
      return;
    }
    // 桌面 UI 事件(工单 09):同一控制面连接上的 ui-event 帧转发渲染层。
    const uiEvent = parseDesktopUiEvent(raw);
    if (uiEvent) {
      try {
        deps.onUiEvent?.(uiEvent.name, uiEvent.payload);
      } catch (error) {
        log('warn', `ui-event 转发异常(name=${uiEvent.name}): ${String(error)}`);
      }
    }
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
