// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startMock: vi.fn(() => Promise.resolve({ terminalId: 'terminal-a' })),
  attachMock: vi.fn(() => Promise.resolve()),
  detachMock: vi.fn(() => Promise.resolve()),
  closeMock: vi.fn(() => Promise.resolve()),
  writeMock: vi.fn(() => Promise.resolve()),
  resizeMock: vi.fn(() => Promise.resolve()),
  terminalWrites: [] as string[],
  terminalInstances: [] as Array<{ options: Record<string, unknown> }>,
  terminalViewport: null as HTMLElement | null,
  parentMouseDowns: 0,
  resizeObserverCallback: null as (() => void) | null,
}));

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

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown>;
    element: HTMLElement | null = null;

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
      this.element = xterm;
      mocks.terminalViewport = viewport;
    }

    onData() {
      return { dispose() {} };
    }

    focus() {}
    blur() {}
    refresh() {}
    dispose() {}

    write(data: string) {
      mocks.terminalWrites.push(data);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
  },
}));

import { setPref } from '../../../lib/appearance';
import { releaseAllSessions } from '../../../lib/terminal/sessionRegistry';
import { TerminalView } from './TerminalView';

const KEY = 'session-a:terminal:D:/project/app';
const PROJECT = 'D:/project/app';

describe('TerminalView', () => {
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
    mocks.terminalInstances.length = 0;
    mocks.terminalViewport = null;
    mocks.parentMouseDowns = 0;
    mocks.resizeObserverCallback = null;
    setPref('codeFontSize', 14);
  });

  afterEach(() => {
    cleanup();
    releaseAllSessions();
    vi.unstubAllGlobals();
  });

  it('renders one terminal and starts one PTY', async () => {
    render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);

    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledTimes(1));
    expect(mocks.startMock).toHaveBeenCalledWith(PROJECT, 100, 30, expect.any(Function));
    expect(mocks.terminalInstances).toHaveLength(1);
  });

  it('does not reconnect when the tab becomes inactive and active again', async () => {
    const view = render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);
    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledTimes(1));

    view.rerender(<TerminalView sessionKey={KEY} projectPath={PROJECT} isActive={false} />);
    view.rerender(<TerminalView sessionKey={KEY} projectPath={PROJECT} isActive />);

    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.attachMock).not.toHaveBeenCalled();
    expect(mocks.detachMock).not.toHaveBeenCalled();
    expect(mocks.closeMock).not.toHaveBeenCalled();
    expect(mocks.terminalInstances).toHaveLength(1);
  });

  it('reuses the existing terminal across a component remount', async () => {
    const first = render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);
    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);

    expect(mocks.startMock).toHaveBeenCalledTimes(1);
    expect(mocks.terminalInstances).toHaveLength(1);
    expect(document.querySelector('.terminal-xterm-shell')?.parentElement).not.toBeNull();
  });

  it('shows the daemon error instead of silently failing', async () => {
    mocks.startMock.mockRejectedValueOnce(new Error('Failed to start terminal'));

    render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);

    await waitFor(() => expect(screen.getByText(/Failed to start terminal/)).toBeTruthy());
  });

  it('does not let xterm consume scrollbar drag start events', async () => {
    render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);
    await waitFor(() => expect(mocks.terminalViewport).not.toBeNull());

    fireEvent.mouseDown(mocks.terminalViewport!, { clientX: 195 });
    expect(mocks.parentMouseDowns).toBe(0);

    fireEvent.mouseDown(mocks.terminalViewport!, { clientX: 100 });
    expect(mocks.parentMouseDowns).toBe(1);
  });

  it('drags the scrollbar to scroll the xterm viewport', async () => {
    render(<TerminalView sessionKey={KEY} projectPath={PROJECT} />);

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
});
