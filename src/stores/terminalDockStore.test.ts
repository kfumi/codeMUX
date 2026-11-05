import { beforeEach, describe, expect, it, vi } from 'vitest';

const persisted = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock('../lib/layoutPreferences', () => ({
  readLayoutPreferences: () => ({}),
  updateLayoutPreferences: persisted.update,
}));

import {
  TERMINAL_DOCK_DEFAULT_HEIGHT,
  TERMINAL_DOCK_MIN_HEIGHT,
  useTerminalDockStore,
} from './terminalDockStore';

const PROJECT = 'D:/project/app';
const OTHER = 'D:/project/other';

describe('terminal dock store', () => {
  beforeEach(() => {
    persisted.update.mockClear();
    useTerminalDockStore.getState().reset();
  });

  it('creates one terminal lazily when the dock opens', () => {
    useTerminalDockStore.getState().open(PROJECT);

    const state = useTerminalDockStore.getState();
    const workspace = state.workspaces[PROJECT];
    expect(state.isOpen).toBe(true);
    expect(workspace.sessionIds).toHaveLength(1);
    expect(state.sessions[workspace.sessionIds[0]].title).toBe('app');
    expect(workspace.activeSessionId).toBe(workspace.sessionIds[0]);
    expect(persisted.update).toHaveBeenCalledWith({ terminalDockOpen: true });
  });

  it('does not add a second terminal when opening an already-open project', () => {
    const store = useTerminalDockStore.getState();
    store.open(PROJECT);
    store.open(PROJECT);

    expect(useTerminalDockStore.getState().workspaces[PROJECT].sessionIds).toHaveLength(1);
  });

  it('numbers tabs from the smallest unused index', () => {
    const store = useTerminalDockStore.getState();
    store.open(PROJECT);
    const second = store.newTerminal(PROJECT)!;
    store.newTerminal(PROJECT);

    const workspace = useTerminalDockStore.getState().workspaces[PROJECT];
    expect(workspace.sessionIds).toHaveLength(3);
    expect(useTerminalDockStore.getState().sessions[second].title).toBe('app 2');

    // 关掉 2 再新建：序号 2 被复用，而不是继续增长到 4。
    useTerminalDockStore.getState().closeTerminal(second);
    const replacement = useTerminalDockStore.getState().newTerminal(PROJECT)!;
    expect(useTerminalDockStore.getState().sessions[replacement].title).toBe('app 2');
  });

  it('activates the neighbour when the active tab is closed', () => {
    const store = useTerminalDockStore.getState();
    store.open(PROJECT);
    const first = useTerminalDockStore.getState().workspaces[PROJECT].sessionIds[0];
    const second = store.newTerminal(PROJECT)!;

    expect(useTerminalDockStore.getState().workspaces[PROJECT].activeSessionId).toBe(second);
    useTerminalDockStore.getState().closeTerminal(second);

    expect(useTerminalDockStore.getState().workspaces[PROJECT].activeSessionId).toBe(first);
  });

  it('collapses the dock when the last tab is closed, and reopens with a fresh terminal', () => {
    const store = useTerminalDockStore.getState();
    store.open(PROJECT);
    const only = useTerminalDockStore.getState().workspaces[PROJECT].sessionIds[0];

    useTerminalDockStore.getState().closeTerminal(only);
    expect(useTerminalDockStore.getState().isOpen).toBe(false);
    expect(persisted.update).toHaveBeenCalledWith({ terminalDockOpen: false });

    useTerminalDockStore.getState().open(PROJECT);
    const reopened = useTerminalDockStore.getState().workspaces[PROJECT].sessionIds[0];
    expect(reopened).not.toBe(only);
    expect(useTerminalDockStore.getState().sessions[only]).toBeUndefined();
  });

  it('keeps per-project terminals isolated across project switches', () => {
    const store = useTerminalDockStore.getState();
    store.open(PROJECT);
    const appTerminal = useTerminalDockStore.getState().workspaces[PROJECT].sessionIds[0];

    store.open(OTHER);
    expect(useTerminalDockStore.getState().workspaces[OTHER].sessionIds).toHaveLength(1);

    store.open(PROJECT);
    expect(useTerminalDockStore.getState().workspaces[PROJECT].sessionIds).toEqual([appTerminal]);
  });

  it('clamps the height between the minimum and the surface maximum', () => {
    useTerminalDockStore.getState().setHeight(40);
    expect(useTerminalDockStore.getState().heightPx).toBe(TERMINAL_DOCK_MIN_HEIGHT);

    useTerminalDockStore.getState().setHeight(600, 420);
    expect(useTerminalDockStore.getState().heightPx).toBe(420);

    useTerminalDockStore.getState().setHeight(600);
    expect(useTerminalDockStore.getState().heightPx).toBe(600);
  });

  it('toggles closed and only opens with a project', () => {
    const store = useTerminalDockStore.getState();
    store.toggle(null);
    expect(useTerminalDockStore.getState().isOpen).toBe(false);

    store.toggle(PROJECT);
    expect(useTerminalDockStore.getState().isOpen).toBe(true);

    useTerminalDockStore.getState().toggle(PROJECT);
    expect(useTerminalDockStore.getState().isOpen).toBe(false);
  });

  it('starts from the default height', () => {
    expect(useTerminalDockStore.getState().heightPx).toBe(TERMINAL_DOCK_DEFAULT_HEIGHT);
  });
});
