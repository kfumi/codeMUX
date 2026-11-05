// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startMock: vi.fn(() => Promise.resolve({ terminalId: 'terminal-a' })),
  attachMock: vi.fn(() => Promise.resolve()),
  detachMock: vi.fn(() => Promise.resolve()),
  closeMock: vi.fn(() => Promise.resolve()),
  writeMock: vi.fn(() => Promise.resolve()),
  resizeMock: vi.fn(() => Promise.resolve()),
  terminalWrites: [] as string[],
  terminalDisposals: 0,
  fitCalls: 0,
  fitSize: null as { cols: number; rows: number } | null,
  terminalInstances: [] as Array<{ options: Record<string, unknown> }>,
  resizeObserverCallback: null as (() => void) | null,
  /** 模拟宿主的祖先面板正在跑 CSS 过渡。 */
  animationsRunning: false,
}));

vi.mock('../facades/daemon-facade', () => ({
  daemonFacade: {
    terminal: {
      start: mocks.startMock,
      attach: mocks.attachMock,
      detach: mocks.detachMock,
      close: mocks.closeMock,
      write: mocks.writeMock,
      resize: mocks.resizeMock,
    },
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown>;

    constructor(options?: Record<string, unknown>) {
      this.options = { ...(options ?? {}) };
      mocks.terminalInstances.push(this);
    }

    loadAddon(addon?: { activate?: (terminal: unknown) => void }) {
      addon?.activate?.(this);
    }

    open(container: HTMLElement) {
      const xterm = document.createElement('div');
      xterm.className = 'xterm';
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      xterm.appendChild(viewport);
      container.appendChild(xterm);
    }

    onData() {
      return { dispose() {} };
    }

    focus() {}
    blur() {}
    refresh() {}

    dispose() {
      mocks.terminalDisposals += 1;
    }

    write(data: string) {
      mocks.terminalWrites.push(data);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private terminal: { cols: number; rows: number } | null = null;

    activate(terminal: { cols: number; rows: number }) {
      this.terminal = terminal;
    }

    fit() {
      mocks.fitCalls += 1;
      if (this.terminal && mocks.fitSize) {
        this.terminal.cols = mocks.fitSize.cols;
        this.terminal.rows = mocks.fitSize.rows;
      }
    }
  },
}));

import { __resetForTests, setPref } from '../appearance';
import {
  acquireSession,
  getSessionSnapshot,
  mountSession,
  releaseAllSessions,
  releaseSession,
  setSessionActive,
  unmountSession,
} from './sessionRegistry';

const KEY = 'dock:D:/project/app:1';
const PROJECT = 'D:/project/app';

function container(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function lastEvent(): (event: { type: string; data?: string; code?: number | null; replay?: boolean; error?: string }) => void {
  const calls = mocks.startMock.mock.calls;
  return calls[calls.length - 1]?.[3] as never;
}

describe('terminal session registry', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          mocks.resizeObserverCallback = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    mocks.startMock.mockReset().mockResolvedValue({ terminalId: 'terminal-a' });
    mocks.attachMock.mockClear();
    mocks.detachMock.mockClear();
    mocks.closeMock.mockClear();
    mocks.writeMock.mockClear();
    mocks.resizeMock.mockClear();
    mocks.terminalWrites.length = 0;
    mocks.terminalDisposals = 0;
    mocks.fitCalls = 0;
    mocks.fitSize = null;
    mocks.terminalInstances.length = 0;
    mocks.resizeObserverCallback = null;
    mocks.animationsRunning = false;
    Object.defineProperty(window.HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: () => (mocks.animationsRunning ? [{ playState: 'running' }] : []),
    });
    setPref('codeFontSize', 14);
  });

  afterEach(() => {
    releaseAllSessions();
    __resetForTests();
    document.body.style.userSelect = '';
    Reflect.deleteProperty(window.HTMLElement.prototype, 'getAnimations');
    vi.unstubAllGlobals();
  });

  it('starts exactly one PTY per session and never re-attaches on visibility changes', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });

    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));
    expect(mocks.startMock).toHaveBeenCalledTimes(1);

    setSessionActive(KEY, false);
    setSessionActive(KEY, true);
    setSessionActive(KEY, false);
    setSessionActive(KEY, true);

    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.attachMock).not.toHaveBeenCalled();
    expect(mocks.detachMock).not.toHaveBeenCalled();
    expect(mocks.closeMock).not.toHaveBeenCalled();
  });

  it('moves the xterm host between containers without touching the PTY', async () => {
    const first = container();
    const second = container();
    acquireSession(KEY, { projectPath: PROJECT, container: first, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    const host = first.querySelector('.terminal-xterm-shell');
    expect(host?.parentElement).toBe(first);

    mountSession(KEY, second);
    expect(host?.parentElement).toBe(second);

    unmountSession(KEY);
    expect(document.querySelector('[data-terminal-stash]')?.contains(host!)).toBe(true);

    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.terminalDisposals).toBe(0);
    expect(mocks.closeMock).not.toHaveBeenCalled();
  });

  it('releases the PTY and disposes xterm only on explicit release', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    releaseSession(KEY);

    expect(mocks.closeMock).toHaveBeenCalledWith('terminal-a');
    expect(mocks.terminalDisposals).toBe(1);
    expect(host.querySelector('.xterm')).toBeNull();
    // 幂等：重复释放不再触发第二次 close。
    releaseSession(KEY);
    expect(mocks.closeMock).toHaveBeenCalledTimes(1);
  });

  it('buffers output while hidden and flushes it once on activation', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    const handleEvent = lastEvent();
    setSessionActive(KEY, false);
    handleEvent({ type: 'output', data: 'aaa' });
    handleEvent({ type: 'output', data: 'bbb' });
    expect(mocks.terminalWrites).toEqual([]);

    setSessionActive(KEY, true);
    expect(mocks.terminalWrites).toEqual(['aaabbb']);
  });

  it('writes live output straight through and records the exit code', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    const handleEvent = lastEvent();
    handleEvent({ type: 'output', data: 'live' });
    handleEvent({ type: 'exit', code: 7 });

    expect(mocks.terminalWrites).toEqual(['live', '\r\n[进程已退出: 7]\r\n']);
    expect(getSessionSnapshot(KEY).status).toBe('exited');
  });

  it('keeps only the tail of hidden output, aligned to a line boundary', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: false });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    const handleEvent = lastEvent();
    for (let index = 0; index < 200; index += 1) {
      handleEvent({ type: 'output', data: `${index}:${'x'.repeat(997)}\n` });
    }

    setSessionActive(KEY, true);
    expect(mocks.terminalWrites).toHaveLength(1);
    const notice = '\r\n[隐藏期间的早期输出已省略]\r\n';
    const flushed = mocks.terminalWrites[0];
    expect(flushed.startsWith(notice)).toBe(true);
    expect(flushed.endsWith(`199:${'x'.repeat(997)}\n`)).toBe(true);
    expect(flushed.slice(notice.length).length).toBeLessThanOrEqual(128 * 1024);
  });

  it('clears the view before a replayed buffer', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));

    lastEvent()({ type: 'output', data: 'history', replay: true });
    expect(mocks.terminalWrites).toEqual([`\x1bchistory`]);
  });

  it('coalesces a burst of size changes into one latest-wins PTY resize', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));
    mocks.resizeMock.mockClear();

    for (const [cols, rows] of [[2, 30], [10, 30], [24, 30], [72, 30]]) {
      mocks.fitSize = { cols, rows };
      mocks.resizeObserverCallback?.();
    }

    expect(mocks.resizeMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.resizeMock).toHaveBeenCalledTimes(1));
    expect(mocks.resizeMock).toHaveBeenCalledWith('terminal-a', 72, 30);
  });

  it('defers fitting and the PTY resize until the surface transition finishes', async () => {
    mocks.animationsRunning = true;
    // 宿主挂在正在做宽度过渡的面板里（与 SidePanel 的结构一致）。
    const panel = document.createElement('aside');
    document.body.appendChild(panel);
    const host = document.createElement('div');
    panel.appendChild(host);

    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));
    mocks.resizeMock.mockClear();
    const fitsBefore = mocks.fitCalls;

    // 过渡起步很慢：这里模拟宽度只有几列时的中间态。它们既不能 fit，
    // 更不能发给 PTY —— 否则 PSReadLine 会在 1~2 列宽下重画 prompt 留下残影。
    for (const cols of [2, 4, 8]) {
      mocks.fitSize = { cols, rows: 30 };
      mocks.resizeObserverCallback?.();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mocks.fitCalls).toBe(fitsBefore);
    expect(mocks.resizeMock).not.toHaveBeenCalled();

    // 过渡结束：只做一次干净 fit，并把最终尺寸同步给 PTY。
    mocks.animationsRunning = false;
    mocks.fitSize = { cols: 72, rows: 30 };
    mocks.resizeObserverCallback?.();

    await vi.waitFor(() => expect(mocks.resizeMock).toHaveBeenCalledTimes(1));
    expect(mocks.resizeMock).toHaveBeenCalledWith('terminal-a', 72, 30);
  });

  it('never resizes before the PTY id is known', async () => {
    let resolveStart: ((result: { terminalId: string }) => void) | undefined;
    mocks.startMock.mockImplementationOnce(() => new Promise<{ terminalId: string }>((resolve) => {
      resolveStart = resolve;
    }));

    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    mocks.fitSize = { cols: 40, rows: 30 };
    mocks.resizeObserverCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(mocks.resizeMock).not.toHaveBeenCalled();
    resolveStart?.({ terminalId: 'terminal-late' });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));
  });

  it('applies code font size as a view option without creating a second terminal', async () => {
    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    await vi.waitFor(() => expect(getSessionSnapshot(KEY).status).toBe('running'));
    const instancesBefore = mocks.terminalInstances.length;
    const fitsBefore = mocks.fitCalls;

    setPref('codeFontSize', 18);

    await vi.waitFor(() => expect(mocks.terminalInstances[instancesBefore - 1].options.fontSize).toBe(18));
    expect(mocks.terminalInstances.length).toBe(instancesBefore);
    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.fitCalls).toBeGreaterThan(fitsBefore));
  });

  it('recycles a session that was released while its PTY was still starting', async () => {
    let resolveStart: ((result: { terminalId: string }) => void) | undefined;
    mocks.startMock.mockImplementationOnce(() => new Promise<{ terminalId: string }>((resolve) => {
      resolveStart = resolve;
    }));

    const host = container();
    acquireSession(KEY, { projectPath: PROJECT, container: host, active: true });
    releaseSession(KEY);
    resolveStart?.({ terminalId: 'terminal-orphan' });

    await vi.waitFor(() => expect(mocks.closeMock).toHaveBeenCalledWith('terminal-orphan'));
  });
});
