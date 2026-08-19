import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidePanelStore } from './sidePanelStore';
import { useNavigationStore } from './navigationStore';

describe('side panel store', () => {
  beforeEach(() => {
    useSidePanelStore.getState().reset();
    useNavigationStore.getState().reset();
    vi.stubGlobal('window', { innerWidth: 1024 });
  });

  it('opens review and terminal tabs and activates the requested tab', () => {
    const store = useSidePanelStore.getState();

    store.openReviewTab('D:/project/app');
    store.openTerminalTab('D:/project/app');

    const state = useSidePanelStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['review', 'terminal']);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    expect(state.tabs[0]).toMatchObject({
      kind: 'review',
      title: '审查',
      projectPath: 'D:/project/app',
    });
  });

  it('opens and reuses a plan preview tab by plan file path', () => {
    const store = useSidePanelStore.getState();

    store.openPlanTab('docs/superpowers/plans/exit-plan.md', '# 初版计划');
    store.openPlanTab('docs/superpowers/plans/exit-plan.md', '# 更新后的计划');

    const state = useSidePanelStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(state.tabs[0]).toMatchObject({
      kind: 'plan',
      title: 'exit-plan.md',
      planFilePath: 'docs/superpowers/plans/exit-plan.md',
      planContent: '# 更新后的计划',
    });
  });

  it('reuses an existing tab of the same kind for a project', () => {
    const store = useSidePanelStore.getState();

    store.openReviewTab('D:/project/app');
    store.openReviewTab('D:/project/app');

    const state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe('review');
  });

  it('keeps the panel open as an empty workspace when the last tab closes', () => {
    const store = useSidePanelStore.getState();

    store.openReviewTab('D:/project/app');
    const tabId = useSidePanelStore.getState().activeTabId!;
    store.closeTab(tabId);

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [],
      activeTabId: null,
    });
  });

  it('can collapse the panel without discarding tabs', () => {
    const store = useSidePanelStore.getState();

    store.openReviewTab('D:/project/app');
    store.closePanel();

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: false,
      tabs: [{ kind: 'review' }],
    });
  });

  it('can open the panel as an empty workspace', () => {
    const store = useSidePanelStore.getState();

    store.openPanel();

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [],
      activeTabId: null,
    });
  });

  it('toggles one expanded state for the panel width', () => {
    const store = useSidePanelStore.getState();

    expect(useSidePanelStore.getState().isExpanded).toBe(false);
    store.toggleExpanded();
    expect(useSidePanelStore.getState().isExpanded).toBe(true);
    store.toggleExpanded();
    expect(useSidePanelStore.getState().isExpanded).toBe(false);
  });

  it('keeps tabs and panel visibility scoped to each conversation', () => {
    const store = useSidePanelStore.getState();

    store.setScope('session-a');
    store.openReviewTab('D:/project/a');
    store.closePanel();

    store.setScope('session-b');
    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: false,
      tabs: [],
      activeTabId: null,
    });

    useSidePanelStore.getState().openTerminalTab('D:/project/b');
    expect(useSidePanelStore.getState().tabs).toHaveLength(1);

    useSidePanelStore.getState().setScope('session-a');
    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: false,
      tabs: [{ kind: 'review', projectPath: 'D:/project/a' }],
    });

    useSidePanelStore.getState().openPlanTab('docs/plan.md', '# A');
    expect(useSidePanelStore.getState().tabs).toEqual([
      expect.objectContaining({ kind: 'review', projectPath: 'D:/project/a' }),
      expect.objectContaining({ kind: 'plan', planFilePath: 'docs/plan.md', planContent: '# A' }),
    ]);

    useSidePanelStore.getState().setScope('session-b');
    expect(useSidePanelStore.getState().tabs).toEqual([
      expect.objectContaining({ kind: 'terminal', projectPath: 'D:/project/b' }),
    ]);
  });

  it('recognizes tabs preserved in inactive scopes but not explicitly closed tabs', () => {
    const store = useSidePanelStore.getState();

    store.setScope('session-a');
    store.openTerminalTab('D:/project/a');
    const terminalTabId = useSidePanelStore.getState().activeTabId!;

    store.setScope('session-b');
    expect(useSidePanelStore.getState().isTabPresent(terminalTabId)).toBe(true);

    store.setScope('session-a');
    store.closeTab(terminalTabId);
    expect(useSidePanelStore.getState().isTabPresent(terminalTabId)).toBe(false);
  });

  it('assigns a new instance id when reopening a closed terminal', () => {
    const store = useSidePanelStore.getState();

    store.setScope('session-a');
    store.openTerminalTab('D:/project/a');
    const firstTerminalTabId = useSidePanelStore.getState().activeTabId!;

    store.closeTab(firstTerminalTabId);
    store.openTerminalTab('D:/project/a');
    const secondTerminalTabId = useSidePanelStore.getState().activeTabId!;

    expect(secondTerminalTabId).not.toBe(firstTerminalTabId);
  });

  it('lets the side panel grow until the conversation area reaches its minimum width', () => {
    vi.stubGlobal('window', { innerWidth: 1920 });

    useSidePanelStore.getState().setPanelWidth(1800);

    expect(useSidePanelStore.getState().panelWidth).toBe(1480);
  });

  it('uses the split container width when clamping side panel growth', () => {
    vi.stubGlobal('window', { innerWidth: 1920 });

    useSidePanelStore.getState().setPanelWidth(1800, 1620);

    expect(useSidePanelStore.getState().panelWidth).toBe(1180);
  });

  it('does not clear the active scope when restoring its navigation', () => {
    const store = useSidePanelStore.getState();

    store.setScope('session-a');
    store.openTerminalTab('D:/project/app');
    const terminalTabId = useSidePanelStore.getState().activeTabId!;

    store.restoreNavigation({
      scopeId: 'session-a',
      isOpen: true,
      activeTabId: terminalTabId,
    });

    expect(useSidePanelStore.getState()).toMatchObject({
      activeScopeId: 'session-a',
      isOpen: true,
      tabs: [{ kind: 'terminal', projectPath: 'D:/project/app' }],
      activeTabId: terminalTabId,
    });
  });
});
