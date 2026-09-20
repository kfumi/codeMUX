// Browser 自动化接缝(工单 08)main 侧契约测试:ws 与 node:http 以替身注入,
// 覆盖 FIFO 串行、四种 op 分发、browserId 缺失报错、result 回包的 URL/token 形状。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- ws 替身:记录实例与连接 URL,测试手动派发 open/message/close ------------
const wsState = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    url: string;
    readyState = 0;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(listener);
      this.handlers.set(event, list);
      return this;
    }
    send(): void {}
    close(): void {
      this.emit('close', 1000, Buffer.alloc(0));
    }
    removeAllListeners(): void {
      this.handlers.clear();
    }
    terminate(): void {
      this.emit('close', 1006, Buffer.alloc(0));
    }
    emitOpen(): void {
      this.readyState = 1;
      this.emit('open');
    }
    emitMessage(payload: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(payload)));
    }
    emitClose(): void {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.alloc(0));
    }
    private emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.handlers.get(event) ?? [])]) {
        listener(...args);
      }
    }
  }
  return { FakeWebSocket, instances: FakeWebSocket.instances };
});

vi.mock('ws', () => ({ default: wsState.FakeWebSocket }));

// --- node:http 替身:记录 result POST 的 options 与 body --------------------
const httpState = vi.hoisted(() => {
  interface RecordedRequest {
    options: {
      host: string;
      port: number;
      path: string;
      method: string;
      headers: Record<string, string | number>;
      timeout?: number;
    };
    body: string | null;
    request: {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
      destroy(): void;
      end(body?: string): void;
    };
  }
  const requests: RecordedRequest[] = [];
  class FakeClientRequest {
    body: string | null = null;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(
      public options: RecordedRequest['options'],
      private onResponse: (response: unknown) => void,
    ) {
      requests.push({ options, body: null, request: this as unknown as RecordedRequest['request'] });
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    destroy(): void {
      this.emit('error', new Error('destroyed'));
    }
    end(body?: string): void {
      this.body = body ?? null;
      const recorded = requests.find((item) => item.request === (this as unknown));
      if (recorded) recorded.body = this.body;
      // 模拟 daemon 侧 200 响应(异步,保持测试确定性)。
      queueMicrotask(() => {
        this.onResponse({ resume(): void {} });
      });
    }
    private emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }
  }
  return {
    requests,
    request: (options: RecordedRequest['options'], onResponse: (response: unknown) => void) =>
      new FakeClientRequest(options, onResponse),
  };
});

vi.mock('node:http', () => ({ default: { request: httpState.request } }));

import {
  createBrowserAutomationService,
  executeAutomationRequest,
  mapInputParams,
  parseAutomationRequest,
  stringifyEvaluateResult,
  type AutomationRequest,
  type AutomationTarget,
} from '../src/browser-automation';

interface DeferredResolve {
  resolve: () => void;
}

function makeTarget(overrides: Partial<AutomationTarget> = {}): AutomationTarget & {
  calls: { execute: string[]; input: unknown[]; cdp: Array<{ method: string; params: unknown }> };
} {
  const calls = { execute: [] as string[], input: [] as unknown[], cdp: [] as Array<{ method: string; params: unknown }> };
  return {
    calls,
    executeJavaScript: overrides.executeJavaScript
      ? overrides.executeJavaScript
      : async (code: string) => {
          calls.execute.push(code);
          return { code };
        },
    capturePage:
      overrides.capturePage ??
      (async () => ({
        toPNG: () => Buffer.from([137, 80, 78, 71]),
      })),
    sendInputEvent:
      overrides.sendInputEvent ??
      ((event: Record<string, unknown>) => {
        calls.input.push(event);
      }),
    debugger:
      overrides.debugger ?? {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          calls.cdp.push({ method, params });
          return { ok: true, method };
        },
      },
  };
}

function lastRequest() {
  return httpState.requests[httpState.requests.length - 1];
}

async function until(condition: () => boolean, message = 'condition not met'): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3_000) {
      throw new Error(`until 超时: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function serviceDeps(overrides: {
  getPort?: () => number | null;
  readToken?: () => string | null;
  resolveTarget?: (browserId: string) => AutomationTarget | undefined;
  resolveMostRecent?: () => AutomationTarget | undefined;
  listTargets?: () => Array<{ browserId: string; url: string; title: string }>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}) {
  return {
    getPort: overrides.getPort ?? (() => 4321),
    readToken: overrides.readToken ?? (() => 'tok-1'),
    resolveTarget: overrides.resolveTarget ?? (() => undefined),
    ...(overrides.resolveMostRecent ? { resolveMostRecent: overrides.resolveMostRecent } : {}),
    listTargets: overrides.listTargets ?? (() => []),
    reconnectBaseDelayMs: 1,
    ...(overrides.log ? { log: overrides.log } : {}),
  };
}

/** start → 连接建立(open),返回当前 socket。 */
async function startAndConnect(deps: ReturnType<typeof serviceDeps>) {
  const service = createBrowserAutomationService(deps);
  service.start();
  await until(() => wsState.instances.length > 0, 'ws instance created');
  const socket = wsState.instances[wsState.instances.length - 1];
  socket.emitOpen();
  await until(() => service.isConnected(), 'socket open');
  return { service, socket };
}

function automationRequestEvent(request: AutomationRequest) {
  return { type: 'event', sessionId: '', event: { type: 'browser-automation-request', ...request } };
}

beforeEach(() => {
  wsState.instances.length = 0;
  httpState.requests.length = 0;
});

describe('browser-automation 连接(工单 08 壳侧)', () => {
  it('连接 URL:回环 daemon /api/ws + local daemon token(query)', async () => {
    const service = createBrowserAutomationService(
      serviceDeps({ getPort: () => 51234, readToken: () => 'secret-token/+' }),
    );
    service.start();
    await until(() => wsState.instances.length > 0);
    expect(wsState.instances[0].url).toBe(
      'ws://127.0.0.1:51234/api/ws?token=' + encodeURIComponent('secret-token/+'),
    );
    service.stop();
  });

  it('daemon 未就绪(无端口/token)时不连接也不崩溃,退避后重试成功', async () => {
    let port: number | null = null;
    const service = createBrowserAutomationService(serviceDeps({ getPort: () => port }));
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wsState.instances.length).toBe(0);

    port = 4321;
    await until(() => wsState.instances.length > 0, '重试后建立连接');
    service.stop();
  });

  it('stop() 后断开且不再重连', async () => {
    vi.useFakeTimers();
    try {
      const service = createBrowserAutomationService(serviceDeps({}));
      service.start();
      await vi.advanceTimersByTimeAsync(5);
      expect(wsState.instances.length).toBe(1);
      const socket = wsState.instances[0];
      socket.emitOpen();
      socket.emitClose();
      // 断开 → 安排重连(指数退避);stop 必须清掉重连定时器。
      await vi.advanceTimersByTimeAsync(5);
      expect(wsState.instances.length).toBe(2);
      service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wsState.instances.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('browser-automation 请求执行(队列与 op 分发)', () => {
  it('eval:executeJavaScript 结果按工单 07 契约回传 JSON 文本', async () => {
    const target = makeTarget();
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: (id) => (id === 'browser-1' ? target : undefined) }));
    socket.emitMessage(
      automationRequestEvent({ requestId: 'req-1', browserId: 'browser-1', op: 'eval', params: { code: '1+1' } }),
    );
    await until(() => httpState.requests.length === 1, 'result posted');

    expect(target.calls.execute).toEqual(['1+1']);
    const recorded = lastRequest();
    // 成功回包不带 error 键(JSON.stringify 省略 undefined)。
    expect(JSON.parse(recorded.body ?? '{}')).toEqual({
      requestId: 'req-1',
      ok: true,
      payload: JSON.stringify({ code: '1+1' }),
    });
    service.stop();
  });

  it('eval:undefined 结果序列化为 "null"(与渲染层 evaluate 契约一致)', async () => {
    expect(stringifyEvaluateResult(undefined)).toBe('null');
    expect(stringifyEvaluateResult(42)).toBe('42');
    expect(stringifyEvaluateResult({ a: [1] })).toBe('{"a":[1]}');
  });

  it('screenshot:capturePage().toPNG() 以 base64 字符串回传', async () => {
    const target = makeTarget();
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: (id) => (id === 'browser-1' ? target : undefined) }));
    socket.emitMessage(automationRequestEvent({ requestId: 'req-2', browserId: 'browser-1', op: 'screenshot' }));
    await until(() => httpState.requests.length === 1);

    const body = JSON.parse(lastRequest().body ?? '{}');
    expect(body.ok).toBe(true);
    expect(body.payload).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'));
    service.stop();
  });

  it('input:sendInputEvent 注入白名单字段的可信输入事件', async () => {
    const target = makeTarget();
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: (id) => (id === 'browser-1' ? target : undefined) }));
    socket.emitMessage(
      automationRequestEvent({
        requestId: 'req-3',
        browserId: 'browser-1',
        op: 'input',
        params: { type: 'mouseDown', x: 12, y: 34, button: 'left', clickCount: 1, keyCode: 'ignored-for-mouse' },
      }),
    );
    await until(() => httpState.requests.length === 1);

    expect(target.calls.input).toEqual([
      { type: 'mouseDown', x: 12, y: 34, button: 'left', clickCount: 1, keyCode: 'ignored-for-mouse' },
    ]);
    expect(JSON.parse(lastRequest().body ?? '{}').ok).toBe(true);
    service.stop();
  });

  it('cdp:幂等 attach 后 sendCommand,响应原样回传;已附挂不重复 attach', async () => {
    let attached = 0;
    const target = makeTarget({
      debugger: {
        isAttached: () => attached > 0,
        attach: () => {
          attached += 1;
        },
        detach: () => {
          attached = 0;
        },
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          target.calls.cdp.push({ method, params });
          return { frameId: 'f-1' };
        },
      },
    });
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: (id) => (id === 'browser-1' ? target : undefined) }));
    socket.emitMessage(
      automationRequestEvent({ requestId: 'req-4', browserId: 'browser-1', op: 'cdp', params: { method: 'Page.enable' } }),
    );
    await until(() => target.calls.cdp.length === 1);
    await until(() => httpState.requests.length === 1);

    expect(attached).toBe(1);
    expect(target.calls.cdp[0]).toEqual({ method: 'Page.enable', params: undefined });
    expect(JSON.parse(lastRequest().body ?? '{}').payload).toEqual({ frameId: 'f-1' });

    // 第二条 CDP 请求:已附挂 → 不再 attach,继续 sendCommand。
    socket.emitMessage(
      automationRequestEvent({
        requestId: 'req-5',
        browserId: 'browser-1',
        op: 'cdp',
        params: { method: 'Runtime.evaluate', params: { expression: '1' } },
      }),
    );
    await until(() => target.calls.cdp.length === 2);
    await until(() => httpState.requests.length === 2);
    expect(attached).toBe(1);
    expect(target.calls.cdp[1]).toEqual({ method: 'Runtime.evaluate', params: { expression: '1' } });
    service.stop();
  });

  it('browserId 找不到 → 回包 ok:false 且带 error', async () => {
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: () => undefined }));
    socket.emitMessage(automationRequestEvent({ requestId: 'req-6', browserId: 'ghost', op: 'eval', params: { code: '1' } }));
    await until(() => httpState.requests.length === 1);

    const body = JSON.parse(lastRequest().body ?? '{}');
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ghost');
    service.stop();
  });

  it('未知 op → 回包 ok:false', async () => {
    const target = makeTarget();
    const { service, socket } = await startAndConnect(serviceDeps({ resolveTarget: () => target }));
    socket.emitMessage(automationRequestEvent({ requestId: 'req-7', browserId: 'browser-1', op: 'aria-snapshot' }));
    await until(() => httpState.requests.length === 1);

    const body = JSON.parse(lastRequest().body ?? '{}');
    expect(body.ok).toBe(false);
    expect(body.error).toContain('aria-snapshot');
    expect(target.calls.execute).toEqual([]);
    service.stop();
  });

  it('执行抛错(eval reject)→ 回包 ok:false 且队列继续处理下一条', async () => {
    const failing = makeTarget({
      executeJavaScript: async () => {
        throw new Error('boom');
      },
    });
    const healthy = makeTarget();
    const targets: Record<string, AutomationTarget> = { 'browser-1': failing, 'browser-2': healthy };
    const { service, socket } = await startAndConnect(
      serviceDeps({ resolveTarget: (id) => targets[id] }),
    );
    socket.emitMessage(automationRequestEvent({ requestId: 'req-8', browserId: 'browser-1', op: 'eval', params: { code: 'x' } }));
    socket.emitMessage(automationRequestEvent({ requestId: 'req-9', browserId: 'browser-2', op: 'eval', params: { code: 'y' } }));
    await until(() => httpState.requests.length === 2, '两条请求都回包');

    expect(JSON.parse(httpState.requests[0].body ?? '{}')).toMatchObject({ requestId: 'req-8', ok: false });
    expect(httpState.requests[0].body).toContain('boom');
    expect(JSON.parse(httpState.requests[1].body ?? '{}')).toMatchObject({ requestId: 'req-9', ok: true });
    service.stop();
  });

  it('FIFO:并发请求串行执行,顺序与到达顺序一致,任意时刻至多一条在执行', async () => {
    const waiters: DeferredResolve[] = [];
    const executionOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const target = makeTarget({
      executeJavaScript: (code: string) =>
        new Promise<void>((resolve) => {
          executionOrder.push(code);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          waiters.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
    });
    const { service, socket } = await startAndConnect(
      serviceDeps({ resolveTarget: () => target }),
    );

    socket.emitMessage(automationRequestEvent({ requestId: 'r-3', browserId: 'b', op: 'eval', params: { code: 'third' } }));
    socket.emitMessage(automationRequestEvent({ requestId: 'r-1', browserId: 'b', op: 'eval', params: { code: 'first' } }));
    socket.emitMessage(automationRequestEvent({ requestId: 'r-2', browserId: 'b', op: 'eval', params: { code: 'second' } }));

    // 只有第一条真正开始执行(串行);后两条在队列中等待。
    await until(() => executionOrder.length === 1);
    expect(executionOrder).toEqual(['third']);
    expect(maxInFlight).toBe(1);

    waiters[0]();
    await until(() => executionOrder.length === 2);
    waiters[1]();
    await until(() => executionOrder.length === 3);
    waiters[2]();
    await until(() => httpState.requests.length === 3);

    // FIFO:执行顺序 = 到达顺序(third → first → second,按 emit 顺序)。
    expect(executionOrder).toEqual(['third', 'first', 'second']);
    expect(maxInFlight).toBe(1);
    expect(httpState.requests.map((item) => JSON.parse(item.body ?? '{}').requestId)).toEqual(['r-3', 'r-1', 'r-2']);
    service.stop();
  });
});

describe('browser-automation result 回包形状', () => {
  it('POST http://127.0.0.1:<port>/api/browser-automation/result + Bearer token', async () => {
    const target = makeTarget();
    const { service, socket } = await startAndConnect(
      serviceDeps({ getPort: () => 55555, readToken: () => 'tok-xyz', resolveTarget: () => target }),
    );
    socket.emitMessage(automationRequestEvent({ requestId: 'req-u', browserId: 'browser-1', op: 'eval', params: { code: '1' } }));
    await until(() => httpState.requests.length === 1);

    const { options } = lastRequest();
    expect(options.method).toBe('POST');
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(55555);
    expect(options.path).toBe('/api/browser-automation/result');
    expect(options.headers['authorization']).toBe('Bearer tok-xyz');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.headers['content-length']).toBe(Buffer.byteLength(lastRequest().body ?? ''));
    service.stop();
  });

  it('daemon 未就绪时回包被丢弃并告警,不崩溃', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    await postAutomationResultForTest(
      { getPort: () => null, readToken: () => null },
      (level, message) => logs.push({ level, message }),
    );
    expect(logs.some((entry) => entry.level === 'warn' && entry.message.includes('requestId=late'))).toBe(true);
  });

  async function postAutomationResultForTest(
    deps: { getPort: () => number | null; readToken: () => string | null },
    log: (level: 'info' | 'warn' | 'error', message: string) => void,
  ): Promise<void> {
    const { postAutomationResult } = await import('../src/browser-automation');
    await postAutomationResult({ getPort: deps.getPort, readToken: deps.readToken, log }, 'late', {
      ok: true,
      payload: null,
    });
  }
});

describe('browser-automation 纯函数', () => {
  it('parseAutomationRequest:只接受 event 信封内的 browser-automation-request', () => {
    expect(
      parseAutomationRequest(
        JSON.stringify(automationRequestEvent({ requestId: 'r1', browserId: 'b', op: 'eval', params: {} })),
      ),
    ).toMatchObject({ requestId: 'r1', op: 'eval' });
    expect(parseAutomationRequest('not-json')).toBeNull();
    expect(parseAutomationRequest(JSON.stringify({ type: 'state', sessionId: '' }))).toBeNull();
    expect(
      parseAutomationRequest(JSON.stringify({ type: 'event', event: { type: 'other' } })),
    ).toBeNull();
    expect(
      parseAutomationRequest(JSON.stringify({ type: 'event', event: { type: 'browser-automation-request' } })),
    ).toBeNull();
  });

  it('mapInputParams:透传白名单字段', () => {
    expect(mapInputParams({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] })).toEqual({
      type: 'keyDown',
      keyCode: 'Enter',
      modifiers: ['control'],
    });
    expect(mapInputParams(undefined)).toEqual({ type: undefined });
    expect(mapInputParams({ type: 'wheel', deltaX: 3, deltaY: -4 })).toEqual({
      type: 'wheel',
      deltaX: 3,
      deltaY: -4,
    });
  });

  it('executeAutomationRequest:无 browserId 且无最近 guest 直接报错', async () => {
    const outcome = await executeAutomationRequest(
      { resolveTarget: () => makeTarget(), listTargets: () => [] },
      { requestId: 'r', op: 'eval' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('browser not found');
  });

  it('executeAutomationRequest:无 browserId 回落到最近登记的 guest', async () => {
    const target = makeTarget();
    const outcome = await executeAutomationRequest(
      {
        resolveTarget: () => undefined,
        resolveMostRecent: () => target,
        listTargets: () => [],
      },
      { requestId: 'r', op: 'eval', params: { code: '1+1' } },
    );
    expect(outcome.ok).toBe(true);
    expect(target.calls.execute).toEqual(['1+1']);
  });

  it('executeAutomationRequest:list 返回存活 guest 清单(无需目标页)', async () => {
    const guests = [
      { browserId: 'browser-1', url: 'https://a.example', title: 'A' },
      { browserId: 'browser-2', url: 'https://b.example', title: 'B' },
    ];
    const outcome = await executeAutomationRequest(
      { resolveTarget: () => undefined, listTargets: () => guests },
      { requestId: 'r', op: 'list' },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.payload).toEqual(guests);
  });
});
