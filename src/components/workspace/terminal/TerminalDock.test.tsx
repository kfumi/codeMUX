// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  updatePreferences: vi.fn(),
  terminalView: vi.fn(() => null),
  // useSyncExternalStore 要求快照引用稳定：每次返回新对象会触发无限重渲染。
  snapshot: { status: 'running' as const, error: null, terminalId: 't', shell: 'C:\\pwsh.exe' },
}));

vi.mock('./TerminalView', () => ({
  TerminalView: (props: { sessionKey: string; isActive?: boolean }) => mocks.terminalView(props),
}));

vi.mock('../../../lib/terminal/sessionRegistry', () => ({
  terminalRegistry: { release: mocks.release },
  subscribeSession: () => () => {},
  getSessionSnapshot: () => mocks.snapshot,
}));

vi.mock('../../../lib/layoutPreferences', () => ({
  readLayoutPreferences: () => ({}),
  updateLayoutPreferences: mocks.updatePreferences,
}));

import { useTerminalDockStore } from '../../../stores/terminalDockStore';
import { TerminalDock } from './TerminalDock';

const PROJECT = 'D:/project/app';

describe('TerminalDock', () => {
  beforeEach(() => {
    mocks.release.mockClear();
    mocks.updatePreferences.mockClear();
    mocks.terminalView.mockClear();
    useTerminalDockStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    document.body.style.cursor = '';
    document.documentElement.classList.remove('cmx-panel-resizing');
  });

  it('renders nothing until the dock is opened', () => {
    const view = render(<TerminalDock projectPath={PROJECT} />);
    const dock = view.container.querySelector('[data-terminal-dock]');

    expect(dock?.getAttribute('data-terminal-dock')).toBe('closed');
    expect(dock?.getAttribute('style')).toContain('height: 0px');
    expect(mocks.terminalView).not.toHaveBeenCalled();
  });

  it('creates one terminal when opened and renders it as active', () => {
    useTerminalDockStore.setState({ isOpen: true });
    const view = render(<TerminalDock projectPath={PROJECT} />);

    const dock = view.container.querySelector('[data-terminal-dock]');
    expect(dock?.getAttribute('data-terminal-dock')).toBe('open');
    expect(screen.getAllByTestId('terminal-dock-tab')).toHaveLength(1);
    expect(mocks.terminalView).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true }),
    );
  });

  it('adds a tab, switches the active session, and keeps the other tab mounted', () => {
    useTerminalDockStore.setState({ isOpen: true });
    render(<TerminalDock projectPath={PROJECT} />);

    fireEvent.click(screen.getByRole('button', { name: '新建终端' }));

    const tabs = screen.getAllByTestId('terminal-dock-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[1].getAttribute('data-active')).toBe('true');

    fireEvent.click(tabs[0]);
    expect(tabs[0].getAttribute('data-active')).toBe('true');

    // 两个标签都常驻挂载：后台标签只是不可见，不卸载终端。
    expect(mocks.terminalView.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.terminalView).toHaveBeenLastCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  it('releases the terminal when a tab closes and collapses on the last one', () => {
    useTerminalDockStore.setState({ isOpen: true });
    const view = render(<TerminalDock projectPath={PROJECT} />);

    const sessionId = useTerminalDockStore.getState().workspaces[PROJECT].sessionIds[0];
    fireEvent.click(screen.getByRole('button', { name: /关闭 app/ }));

    expect(mocks.release).toHaveBeenCalledWith(sessionId);
    expect(useTerminalDockStore.getState().isOpen).toBe(false);
    expect(view.container.querySelector('[data-terminal-dock]')?.getAttribute('data-terminal-dock')).toBe('closed');
  });

  it('resizes by dragging the top handle and persists the final height', () => {
    useTerminalDockStore.setState({ isOpen: true });
    render(<TerminalDock projectPath={PROJECT} />);

    const handle = screen.getByTestId('terminal-dock-resize-handle');
    fireEvent.mouseDown(handle, { clientY: 500 });
    expect(useTerminalDockStore.getState().isResizing).toBe(true);
    expect(document.documentElement.classList.contains('cmx-panel-resizing')).toBe(true);

    fireEvent.mouseMove(document, { clientY: 440 });
    expect(useTerminalDockStore.getState().heightPx).toBe(320);

    fireEvent.mouseUp(document);
    expect(useTerminalDockStore.getState().isResizing).toBe(false);
    expect(document.documentElement.classList.contains('cmx-panel-resizing')).toBe(false);
    expect(mocks.updatePreferences).toHaveBeenCalledWith({ terminalDockHeight: 320 });
  });

  it('collapses from the header buttons without releasing the PTY', () => {
    useTerminalDockStore.setState({ isOpen: true });
    render(<TerminalDock projectPath={PROJECT} />);

    fireEvent.click(screen.getByRole('button', { name: '收起终端' }));

    expect(useTerminalDockStore.getState().isOpen).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
