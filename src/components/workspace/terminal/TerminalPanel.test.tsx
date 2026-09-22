// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const terminalIds = new Set<string>(['session-a:terminal:D:/project/app']);
  const sidePanelState = {
    setTerminalId: vi.fn(),
    isTabPresent: vi.fn((tabId: string) => terminalIds.has(tabId)),
  };
  const useSidePanelStore = Object.assign(
    (selector: (state: typeof sidePanelState) => unknown) => selector(sidePanelState),
    { getState: () => sidePanelState },
  );

  return {
    startMock: vi.fn(() => Promise.resolve('terminal-a')),
    attachMock: vi.fn((_terminalId?: string, _cols?: number, _rows?: number, _handler?: unknown) => Promise.resolve()),
    detachMock: vi.fn(() => Promise.resolve()),
    closeMock: vi.fn(() => Promise.resolve()),
    writeMock: vi.fn(() => Promise.resolve()),
    resizeMock: vi.fn(() => Promise.resolve()),
    setTerminalIdMock: sidePanelState.setTerminalId,
    isTabPresentMock: sidePanelState.isTabPresent,
    useSidePanelStore,
    terminalWrites: [] as string[],
    terminalBlurs: 0,
    terminalRefreshes: 0,
    fitCalls: 0,
    /** 测试可控的代码字号（`useAppearanceStore` 的 mock 读它）。 */
    codeFontSize: 14,
    /** xterm 实例表：用来断言"没有新建 xterm"以及字号确实写进了视图选项。 */
    terminalInstances: [] as Array<{ options: Record<string, unknown> }>,
    terminalViewport: null as HTMLElement | null,
    parentMouseDowns: 0,
    resizeObserverCallback: null as (() => void) | null,
  };
});

vi.mock('../../../lib/facades/daemon-facade', () => ({
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

vi.mock('../../../stores/sidePanelStore', () => ({
  useSidePanelStore: mocks.useSidePanelStore,
}));

vi.mock('../../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) => selector({ prefs: { codeFontSize: mocks.codeFontSize } }),
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({ config: { theme: 'dark' } }),
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

    loadAddon() {}
      open(container: HTMLElement) {
        const xterm = document.createElement('div');
        xterm.className = 'xterm';
        const viewport = document.createElement('div');
        viewport.className = 'xterm-viewport';
        Object.defineProperty(viewport, 'offsetWidth', { configurable: true, value: 200 });
        Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 180 });
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 900 });
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
          bottom: 300,
          height: 300,
          left: 0,
          right: 200,
          top: 0,
          width: 200,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        });
        xterm.addEventListener('mousedown', () => {
          mocks.parentMouseDowns += 1;
        });
        xterm.appendChild(viewport);
        container.appendChild(xterm);
        mocks.terminalViewport = viewport;
      }
    onData() {
      return { dispose() {} };
    }
    blur() {
      mocks.terminalBlurs += 1;
    }
    refresh() {
      mocks.terminalRefreshes += 1;
    }
    dispose() {}
    write(data: string) {
      mocks.terminalWrites.push(data);
    }
    writeln(data: string) {
      mocks.terminalWrites.push(`${data}\n`);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      mocks.fitCalls += 1;
    }
  },
}));

import { TerminalPanel } from './TerminalPanel';

function SessionSwitchHarness() {
  const [view, setView] = useState<'initial' | 'away' | 'back'>('initial');
  const tabId = 'session-a:terminal:D:/project/app';

  return (
    <>
      <button
        onClick={() => {
          setView((current) => current === 'initial' ? 'away' : 'back');
        }}
      >
        切换会话
      </button>
      <TerminalPanel
        tabId={tabId}
        projectPath="D:/project/app"
        isActive={view !== 'away'}
      />
    </>
  );
}

describe('TerminalPanel lifecycle', () => {
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
    mocks.startMock.mockClear();
    mocks.attachMock.mockClear();
    mocks.detachMock.mockClear();
    mocks.closeMock.mockClear();
    mocks.writeMock.mockClear();
    mocks.resizeMock.mockClear();
    mocks.setTerminalIdMock.mockClear();
    mocks.isTabPresentMock.mockClear();
    mocks.isTabPresentMock.mockReturnValue(true);
    mocks.terminalWrites.length = 0;
    mocks.terminalBlurs = 0;
    mocks.terminalRefreshes = 0;
    mocks.fitCalls = 0;
    mocks.terminalViewport = null;
    mocks.parentMouseDowns = 0;
    mocks.resizeObserverCallback = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the terminal mounted while switching sessions', async () => {
    const view = render(<SessionSwitchHarness />);

    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledWith(
      'D:/project/app',
      100,
      30,
      expect.any(Function),
    ));

    fireEvent.click(view.getByRole('button', { name: '切换会话' }));
    expect(mocks.detachMock).not.toHaveBeenCalled();
    expect(mocks.closeMock).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: '切换会话' }));
    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.attachMock).not.toHaveBeenCalled();
  });

  it('closes the terminal when its tab was explicitly removed', async () => {
    mocks.isTabPresentMock.mockReturnValue(false);
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    view.unmount();

    await waitFor(() => expect(mocks.closeMock).toHaveBeenCalledWith('terminal-a'));
    expect(mocks.detachMock).not.toHaveBeenCalled();
  });

  it('starts a replacement terminal only when attach reports a missing session', async () => {
    mocks.attachMock.mockRejectedValueOnce('Terminal session not found');
    mocks.startMock.mockResolvedValueOnce('terminal-b');
    render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledWith(
      'D:/project/app',
      100,
      30,
      expect.any(Function),
    ));
    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.setTerminalIdMock).toHaveBeenCalledWith(
      'session-a:terminal:D:/project/app',
      'terminal-b',
    );
  });

  it('does not resize an existing terminal before attach finishes', async () => {
    let resolveAttach: (() => void) | undefined;
    mocks.attachMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveAttach = resolve;
    }));
    render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    mocks.resizeObserverCallback?.();

    expect(mocks.resizeMock).not.toHaveBeenCalled();
    resolveAttach?.();
    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalledTimes(1));
    expect(mocks.resizeMock).not.toHaveBeenCalled();
  });

  it('does not let xterm consume scrollbar drag start events', async () => {
    render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    await waitFor(() => expect(mocks.terminalViewport).not.toBeNull());

    fireEvent.mouseDown(mocks.terminalViewport!, { clientX: 195 });
    expect(mocks.parentMouseDowns).toBe(0);

    fireEvent.mouseDown(mocks.terminalViewport!, { clientX: 100 });
    expect(mocks.parentMouseDowns).toBe(1);
  });

  it('provides a draggable scrollbar that controls the xterm viewport', async () => {
    render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    const scrollbar = await waitFor(() => screen.getByRole('scrollbar', { name: '终端滚动条' }));
    const track = scrollbar.parentElement!;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 12,
      top: 0,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(scrollbar, { clientY: 50 });
    fireEvent.mouseMove(document, { clientY: 150 });
    expect(mocks.terminalViewport?.scrollTop).toBe(300);
    fireEvent.mouseUp(document);
  });

  it('does not reconnect when an existing terminal becomes visible again', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );
    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.setTerminalIdMock).toHaveBeenCalled());
    const resizeCountBeforeVisibilityToggle = mocks.resizeMock.mock.calls.length;

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );
    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );
    expect(mocks.attachMock).toHaveBeenCalledTimes(1);
    expect(mocks.resizeMock).toHaveBeenCalledTimes(resizeCountBeforeVisibilityToggle);
    expect(mocks.terminalBlurs).toBe(0);
    expect(mocks.terminalRefreshes).toBe(0);
    expect(mocks.detachMock).not.toHaveBeenCalled();
  });

  it('does not leak a second terminal during StrictMode effect replay', async () => {
    const view = render(
      <StrictMode>
        <TerminalPanel
          tabId="session-a:terminal:D:/project/app"
          projectPath="D:/project/app"
        />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalledWith(
      'terminal-a',
      100,
      30,
      expect.any(Function),
    ));
    expect(mocks.closeMock).not.toHaveBeenCalled();

    view.unmount();
    expect(mocks.detachMock).not.toHaveBeenCalled();
  });

  /**
   * 后台标签的终端不解析输出。
   *
   * SidePanel 让所有终端标签常驻挂载（只靠 invisible 隐藏，SidePanel.tsx:304-323），
   * 而 xterm 的 write 是同步解析的——一个跑着 dev server 的后台标签会持续占用主线程。
   * 这里锁的是**计数**（后台期间一次 write 都没有、切回前台只 write 一次），不是毫秒。
   */
  it('buffers output while the tab is in the background and flushes it once on activation', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    const handleEvent = mocks.attachMock.mock.calls[0][3] as (event: {
      type: string;
      data?: string;
      code?: number | null;
    }) => void;

    handleEvent({ type: 'output', data: 'aaa' });
    handleEvent({ type: 'output', data: 'bbb' });

    expect(mocks.terminalWrites).toEqual([]);

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );

    expect(mocks.terminalWrites).toEqual(['aaabbb']);
  });

  it('writes output straight to xterm while the tab is in the foreground', async () => {
    render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    const handleEvent = mocks.attachMock.mock.calls[0][3] as (event: {
      type: string;
      data?: string;
      code?: number | null;
    }) => void;

    handleEvent({ type: 'output', data: 'live' });
    handleEvent({ type: 'exit', code: 0 });

    expect(mocks.terminalWrites).toEqual(['live', '\r\n[进程已退出: 0]\r\n']);
  });

  it('keeps only the tail of the buffered output when a hidden tab floods', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    const handleEvent = mocks.attachMock.mock.calls[0][3] as (event: {
      type: string;
      data?: string;
      code?: number | null;
    }) => void;

    // 每块 1000 字符、带换行，共 200 块 = 200k > 128KiB 上限。
    for (let index = 0; index < 200; index += 1) {
      handleEvent({ type: 'output', data: `${index}:${'x'.repeat(997)}\n` });
    }

    expect(mocks.terminalWrites).toEqual([]);

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );

    expect(mocks.terminalWrites).toHaveLength(1);
    const flushed = mocks.terminalWrites[0];
    const notice = '\r\n[隐藏期间的早期输出已省略]\r\n';
    expect(flushed.startsWith(notice)).toBe(true);
    // 保留的是**尾部**：最后一次输出完好，而且截断对齐到了行首，
    // 所以提示之后就是一整行（行号可以解析出来）——不按行首截会把 ANSI 转义序列切两半。
    expect(flushed.endsWith(`199:${'x'.repeat(997)}\n`)).toBe(true);
    const keptBody = flushed.slice(notice.length);
    expect(Number.parseInt(keptBody, 10)).toBeGreaterThan(0);
    // 上限加上提示本身。
    expect(keptBody.length).toBeLessThanOrEqual(128 * 1024);
  });

  /**
   * 截断必须落在**行界之后**，而 `\r` 也算行界。
   * 进度条那种「用 `\r` 覆盖同一行」的输出没有 `\n`：只找 `\n` 就会退化成按字符切，
   * 而按字符切会把一条 ANSI 转义序列切成两半——终端会把半截转义码当普通文本渲染出来。
   */
  it('aligns the truncation to a CR as well as an LF', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    const handleEvent = mocks.attachMock.mock.calls[0][3] as (event: {
      type: string;
      data?: string;
      code?: number | null;
    }) => void;

    for (let index = 0; index < 200; index += 1) {
      handleEvent({ type: 'output', data: `\u001b[32m${index}:${'x'.repeat(997)}\r` });
    }

    expect(mocks.terminalWrites).toEqual([]);

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );

    expect(mocks.terminalWrites).toHaveLength(1);
    const notice = '\r\n[隐藏期间的早期输出已省略]\r\n';
    const keptBody = mocks.terminalWrites[0].slice(notice.length);
    // 行界之后正好是一块的开头：转义序列要么完整地在，要么根本不在，不会出现半截。
    expect(/^\u001b\[\d+m\d+:/.test(keptBody)).toBe(true);
    expect(keptBody.endsWith('\r')).toBe(true);
  });

  it('drops the whole tail rather than cutting an unterminated single line', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    const handleEvent = mocks.attachMock.mock.calls[0][3] as (event: {
      type: string;
      data?: string;
      code?: number | null;
    }) => void;

    // 单块 200k 字符、**一个行界都没有**：这一次调用就会越界，而尾部没有任何行界可供对齐，
    // 任何字符级截断都可能切坏内容（例如切在一条 ANSI 序列中间）。
    handleEvent({ type: 'output', data: 'x'.repeat(200_000) });

    expect(mocks.terminalWrites).toEqual([]);

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );

    // 只剩提示：宁可少显示，也不吐半截转义码/半截内容。
    expect(mocks.terminalWrites).toEqual(['\r\n[隐藏期间的早期输出已省略]\r\n']);
  });

  it('re-syncs the terminal size when the tab comes back to the foreground', async () => {
    const view = render(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive={false}
      />,
    );

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalled());
    await waitFor(() => expect(mocks.setTerminalIdMock).toHaveBeenCalled());
    const fitsBefore = mocks.fitCalls;

    view.rerender(
      <TerminalPanel
        tabId="session-a:terminal:D:/project/app"
        terminalId="terminal-a"
        projectPath="D:/project/app"
        isActive
      />,
    );

    // 后台期间容器尺寸可能已经变过，而 ResizeObserver 那一刻的回调被 isActive 挡掉了——
    // 切回前台必须主动补跑一次尺寸同步，否则该标签一直用旧 cols/rows 显示。
    expect(mocks.fitCalls).toBe(fitsBefore + 1);
  });

  it('改代码字号只更新视图选项，不新建 PTY', async () => {
    mocks.codeFontSize = 14;
    const props = {
      tabId: 'session-a:terminal:D:/project/app',
      terminalId: 'terminal-a',
      projectPath: 'D:/project/app',
      isActive: true,
    };
    const view = render(<TerminalPanel {...props} />);

    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalledTimes(1));
    const attachesBefore = mocks.attachMock.mock.calls.length;
    const instancesBefore = mocks.terminalInstances.length;
    const fitsBefore = mocks.fitCalls;

    mocks.codeFontSize = 18;
    // 每次都要新建元素：复用同一个 element 引用时 React 会直接 bail out，effect 根本不会跑。
    view.rerender(<TerminalPanel {...props} />);

    await waitFor(() =>
      expect(mocks.terminalInstances[instancesBefore - 1].options.fontSize).toBe(18));

    // 关键不变量：改字号**不新建 xterm、不重新 attach**——那条路径等于换一条 PTY
    // （旧缓冲丢失、daemon 侧多留一条会话），是这次修掉的缺陷本身。
    expect(mocks.terminalInstances.length).toBe(instancesBefore);
    expect(mocks.attachMock.mock.calls.length).toBe(attachesBefore);
    // 字号变了行列数跟着变，所以必须重新 fit 一次（并把新尺寸同步给 daemon）。
    expect(mocks.fitCalls).toBe(fitsBefore + 1);
  });
});
