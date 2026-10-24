// browser_open 的渲染层往返协调器(自举对)契约测试:请求/回包按 requestId 关联、
// 超时收口、无窗口快速失败、未知 requestId 丢弃。不依赖 electron。
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_OPEN_REPLY_TIMEOUT_MS,
  createAgentOpenCoordinator,
  type AgentOpenRequest,
} from '../src/browser-agent-open';

afterEach(() => {
  vi.useRealTimers();
});

function makeDeps(overrides: {
  send?: (request: AgentOpenRequest) => boolean;
  replyTimeoutMs?: number;
} = {}) {
  const sent: AgentOpenRequest[] = [];
  return {
    sent,
    deps: {
      sendOpenRequest:
        overrides.send ??
        ((request: AgentOpenRequest) => {
          sent.push(request);
          return true;
        }),
      ...(overrides.replyTimeoutMs ? { replyTimeoutMs: overrides.replyTimeoutMs } : {}),
      log: () => {},
    },
  };
}

describe('browser-agent-open 协调器(自举对)', () => {
  it('open → 发事件带 requestId/url;回包 browserId 唤醒等待方', async () => {
    const { deps, sent } = makeDeps();
    const coordinator = createAgentOpenCoordinator(deps);
    const pending = coordinator.open('https://github.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://github.com');
    expect(sent[0].requestId).toBeTruthy();

    coordinator.submitResult({ requestId: sent[0].requestId, browserId: 'browser-9' });
    await expect(pending).resolves.toEqual({ ok: true, browserId: 'browser-9' });
    coordinator.dispose();
  });

  it('回包带 error → 失败文案原样透出(渲染层的失败原因面向模型)', async () => {
    const { deps, sent } = makeDeps();
    const coordinator = createAgentOpenCoordinator(deps);
    const pending = coordinator.open('https://example.com');
    coordinator.submitResult({ requestId: sent[0].requestId, error: '面板未挂载' });
    await expect(pending).resolves.toEqual({ ok: false, error: '面板未挂载' });
    coordinator.dispose();
  });

  it('超时:渲染层不回包按失败收口,迟到的回包被丢弃', async () => {
    vi.useFakeTimers();
    const { deps, sent } = makeDeps({ replyTimeoutMs: 50 });
    const coordinator = createAgentOpenCoordinator(deps);
    const pending = coordinator.open('https://example.com');
    const settled = vi.advanceTimersByTimeAsync(60).then(() => pending);
    await expect(settled).resolves.toMatchObject({ ok: false });
    expect(coordinator.submitResult({ requestId: sent[0].requestId, browserId: 'late' })).toBe(false);
    coordinator.dispose();
  });

  it('主窗口不可用(sendOpenRequest=false)快速失败,不等超时', async () => {
    const { deps } = makeDeps({ send: () => false });
    const coordinator = createAgentOpenCoordinator(deps);
    await expect(coordinator.open('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('宿主'),
    });
    coordinator.dispose();
  });

  it('未知/畸形回包:返回 false 并不影响在途请求', async () => {
    const { deps, sent } = makeDeps();
    const coordinator = createAgentOpenCoordinator(deps);
    const pending = coordinator.open('https://example.com');
    expect(coordinator.submitResult(null)).toBe(false);
    expect(coordinator.submitResult({ requestId: 'not-ours', browserId: 'x' })).toBe(false);
    expect(coordinator.submitResult({ requestId: sent[0].requestId })).toBe(true); // 空 browserId 按失败
    await expect(pending).resolves.toMatchObject({ ok: false });
    coordinator.dispose();
  });

  it('dispose:在途请求一律按失败返回', async () => {
    const { deps } = makeDeps();
    const coordinator = createAgentOpenCoordinator(deps);
    const pending = coordinator.open('https://example.com');
    coordinator.dispose();
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining('关闭') });
  });

  it('缺省回包超时小于 daemon 的 15s 等待窗(留出壳侧 guest 轮询余量)', () => {
    expect(AGENT_OPEN_REPLY_TIMEOUT_MS).toBeLessThan(15_000);
  });
});
