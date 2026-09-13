// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDaemonConnectionStore } from './daemonConnectionStore';

/**
 * 引导状态机(工单 02):界面只消费这四个状态,状态机的迁移必须可断言,
 * 否则「桥缺失显示引导界面」的验收点就退化成人工肉眼观察。
 */
describe('daemonConnectionStore', () => {
  beforeEach(() => {
    useDaemonConnectionStore.getState().reset();
  });

  afterEach(() => {
    useDaemonConnectionStore.getState().reset();
  });

  it('starts idle without a pairing prompt', () => {
    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('idle');
    expect(state.strategy).toBeNull();
    expect(state.pairing).toBeNull();
  });

  it('records the desktop shell strategy on connect', () => {
    useDaemonConnectionStore.getState().setConnecting();
    expect(useDaemonConnectionStore.getState().status).toBe('connecting');

    useDaemonConnectionStore.getState().setConnected('shell-bridge');
    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('connected');
    expect(state.strategy).toBe('shell-bridge');
    expect(state.pairing).toBeNull();
    expect(state.error).toBeNull();
  });

  it('keeps user-facing copy when entering a pairing prompt', () => {
    useDaemonConnectionStore.getState().setPairingMode('remote', '配对已失效，请重新配对');
    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('pairing');
    expect(state.pairing).toMatchObject({
      mode: 'remote',
      phase: 'idle',
      message: '配对已失效，请重新配对',
    });
    expect(state.error).toBe('配对已失效，请重新配对');
  });

  it('carries the confirmation code into the waiting phase', () => {
    useDaemonConnectionStore.getState().setPairingMode('loopback');
    useDaemonConnectionStore.getState().setPairingWaiting({
      requestId: 'req-1',
      code: '482913',
      expiresAt: '2026-09-13T00:03:00.000Z',
      desktopId: 'desktop-1',
    });

    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('pairing');
    expect(state.error).toBeNull();
    expect(state.pairing).toEqual({
      mode: 'loopback',
      phase: 'waiting',
      code: '482913',
      requestId: 'req-1',
      expiresAt: '2026-09-13T00:03:00.000Z',
      desktopId: 'desktop-1',
      message: null,
    });
  });

  it('keeps the mode and code when the claim fails', () => {
    useDaemonConnectionStore.getState().setPairingWaiting({
      requestId: 'req-1',
      code: '482913',
      expiresAt: '2026-09-13T00:03:00.000Z',
      desktopId: 'desktop-1',
    });
    useDaemonConnectionStore.getState().setPairingFailure('桌面端拒绝了本次配对');

    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('pairing');
    expect(state.pairing).toMatchObject({
      mode: 'loopback',
      phase: 'failed',
      code: '482913',
      message: '桌面端拒绝了本次配对',
    });
    // 失败请求不能继续被轮询:requestId 必须清空。
    expect(state.pairing?.requestId).toBeNull();
  });

  it('switches to the remote claim phase without losing the mode', () => {
    useDaemonConnectionStore.getState().setPairingMode('remote');
    useDaemonConnectionStore.getState().setPairingClaiming('remote');
    expect(useDaemonConnectionStore.getState().pairing).toMatchObject({
      mode: 'remote',
      phase: 'claiming',
    });
  });

  it('reports unresolvable connection errors as a distinct state', () => {
    useDaemonConnectionStore.getState().setError('无法连接到 CodeMUX 后台服务，请稍后重试。');
    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('无法连接到 CodeMUX 后台服务，请稍后重试。');
    expect(state.pairing).toBeNull();
  });

  it('resets back to idle on disconnect', () => {
    useDaemonConnectionStore.getState().setConnected('paired-browser');
    useDaemonConnectionStore.getState().reset();
    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('idle');
    expect(state.strategy).toBeNull();
    expect(state.error).toBeNull();
    expect(state.pairing).toBeNull();
  });
});
