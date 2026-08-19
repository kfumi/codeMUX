// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
    attachMock: vi.fn(() => Promise.resolve()),
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
    resizeObserverCallback: null as (() => void) | null,
  };
});

vi.mock('../../../lib/tauri', () => ({
  terminalApi: {
    start: mocks.startMock,
    attach: mocks.attachMock,
    detach: mocks.detachMock,
    close: mocks.closeMock,
    write: mocks.writeMock,
    resize: mocks.resizeMock,
  },
}));

vi.mock('../../../stores/sidePanelStore', () => ({
  useSidePanelStore: mocks.useSidePanelStore,
}));

vi.mock('../../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) => selector({ prefs: { codeFontSize: 14 } }),
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({ config: { theme: 'dark' } }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options = {};

    loadAddon() {}
    open() {}
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
    fit() {}
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
});
