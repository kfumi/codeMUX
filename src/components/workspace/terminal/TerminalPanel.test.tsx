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
    setTerminalIdMock: sidePanelState.setTerminalId,
    isTabPresentMock: sidePanelState.isTabPresent,
    useSidePanelStore,
    terminalWrites: [] as string[],
  };
});

vi.mock('../../../lib/tauri', () => ({
  terminalApi: {
    start: mocks.startMock,
    attach: mocks.attachMock,
    detach: mocks.detachMock,
    close: mocks.closeMock,
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
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
      {view !== 'away' && (
        <TerminalPanel
          tabId={tabId}
          terminalId={view === 'back' ? 'terminal-a' : undefined}
          projectPath="D:/project/app"
        />
      )}
    </>
  );
}

describe('TerminalPanel lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    mocks.startMock.mockClear();
    mocks.attachMock.mockClear();
    mocks.detachMock.mockClear();
    mocks.closeMock.mockClear();
    mocks.setTerminalIdMock.mockClear();
    mocks.isTabPresentMock.mockClear();
    mocks.isTabPresentMock.mockReturnValue(true);
    mocks.terminalWrites.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('detaches on session switch and reattaches the existing terminal', async () => {
    const view = render(<SessionSwitchHarness />);

    await waitFor(() => expect(mocks.startMock).toHaveBeenCalledWith(
      'D:/project/app',
      100,
      30,
      expect.any(Function),
    ));

    fireEvent.click(view.getByRole('button', { name: '切换会话' }));
    await waitFor(() => expect(mocks.detachMock).toHaveBeenCalledWith('terminal-a'));
    expect(mocks.closeMock).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: '切换会话' }));
    await waitFor(() => expect(mocks.attachMock).toHaveBeenCalledWith(
      'terminal-a',
      100,
      30,
      expect.any(Function),
    ));
    expect(mocks.startMock).toHaveBeenCalledTimes(1);

    const onEvent = mocks.attachMock.mock.calls[0][3] as (event: { type: 'output'; terminalId: string; data: string }) => void;
    onEvent({ type: 'output', terminalId: 'terminal-a', data: '后台输出\r\n' });
    expect(mocks.terminalWrites).toContain('后台输出\r\n');
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
    await waitFor(() => expect(mocks.detachMock).toHaveBeenCalledWith('terminal-a'));
  });
});
