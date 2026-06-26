import { beforeEach, describe, expect, it } from 'vitest';

import { useSidePanelStore } from './sidePanelStore';

describe('side panel store', () => {
  beforeEach(() => {
    useSidePanelStore.getState().reset();
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
      title: '审核',
      projectPath: 'D:/project/app',
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
  });
});
