import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserStore } from './browserStore';
import { useSidePanelStore } from './sidePanelStore';
import { useNavigationStore } from './navigationStore';

const fileApiMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

const browserApiMock = vi.hoisted(() => ({
  show: vi.fn(),
  hide: vi.fn(),
}));

vi.mock('../lib/tauri', () => ({
  fileApi: fileApiMock,
  browserApi: browserApiMock,
}));

describe('side panel store', () => {
  beforeEach(() => {
    useSidePanelStore.getState().reset();
    useBrowserStore.getState().reset();
    useNavigationStore.getState().reset();
    fileApiMock.readFile.mockReset();
    fileApiMock.writeFile.mockReset();
    browserApiMock.show.mockReset();
    browserApiMock.hide.mockReset();
    browserApiMock.show.mockResolvedValue(undefined);
    browserApiMock.hide.mockResolvedValue(undefined);
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

  it('loads a file into a reusable tab and saves edited content', async () => {
    fileApiMock.readFile.mockResolvedValue('const answer = 41;');
    fileApiMock.writeFile.mockResolvedValue(undefined);
    const store = useSidePanelStore.getState();

    await store.openFileTab('D:/project/app', 'D:/project/app/src/main.ts');

    let state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      kind: 'file',
      title: 'main.ts',
      fileContent: 'const answer = 41;',
      fileOriginalContent: 'const answer = 41;',
      fileLoading: false,
    });
    expect(fileApiMock.readFile).toHaveBeenCalledWith(
      'D:/project/app/src/main.ts',
      'D:/project/app',
    );

    const tabId = state.tabs[0].id;
    store.updateFileContent(tabId, 'const answer = 42;');
    await store.saveFileTab(tabId);

    state = useSidePanelStore.getState();
    expect(fileApiMock.writeFile).toHaveBeenCalledWith(
      'D:/project/app/src/main.ts',
      'const answer = 42;',
      'D:/project/app',
    );
    expect(state.tabs[0]).toMatchObject({
      fileContent: 'const answer = 42;',
      fileOriginalContent: 'const answer = 42;',
      fileSaveState: 'saved',
    });
  });

  it('reuses the same file tab for relative and absolute paths', async () => {
    fileApiMock.readFile.mockResolvedValue('export const answer = 42;');
    const store = useSidePanelStore.getState();

    await store.openFileTab('D:/project/app', 'src/main.ts');
    await store.openFileTab(undefined, 'D:/project/app/src/main.ts');

    const state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(fileApiMock.readFile).toHaveBeenCalledTimes(1);
  });

  it('closes one, other, or all tabs through the tab actions', async () => {
    fileApiMock.readFile.mockResolvedValue('');
    const store = useSidePanelStore.getState();

    await store.openFileTab('D:/project/app', 'src/one.ts');
    await store.openFileTab('D:/project/app', 'src/two.ts');
    const secondTabId = useSidePanelStore.getState().activeTabId!;

    store.closeOtherTabs(secondTabId);
    expect(useSidePanelStore.getState().tabs).toHaveLength(1);

    await store.openFileTab('D:/project/app', 'src/three.ts');
    store.closeAllTabs();
    expect(useSidePanelStore.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      isOpen: true,
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

  it('opens multiple browser tabs and activates the latest one', () => {
    const store = useSidePanelStore.getState();

    const firstTabId = store.openBrowserTab();
    const secondTabId = store.openBrowserTab('https://example.com/');

    const state = useSidePanelStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toMatchObject({
      kind: 'browser',
      title: '新标签页',
      id: firstTabId,
    });
    expect(state.tabs[1]).toMatchObject({
      kind: 'browser',
      title: '新标签页',
      browserInitialUrl: 'https://example.com/',
      id: secondTabId,
    });
    expect(state.activeTabId).toBe(secondTabId);
  });

  it('closes the side panel and hides browser webviews immediately', () => {
    const store = useSidePanelStore.getState();
    const tabId = store.openBrowserTab();
    useBrowserStore.getState().ensureBlankPage(tabId);
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [Object.keys(state.pages)[0]]: {
          ...Object.values(state.pages)[0],
          hostAttached: true,
        },
      },
    }));

    store.closePanel();

    expect(useSidePanelStore.getState().isOpen).toBe(false);
    expect(browserApiMock.hide).toHaveBeenCalled();
  });

  it('updates browser tab titles independently', () => {
    const store = useSidePanelStore.getState();
    const tabId = store.openBrowserTab();

    store.updateBrowserTabTitle(tabId, 'Example Docs');

    expect(useSidePanelStore.getState().tabs[0].title).toBe('Example Docs');
  });

  it('keeps browser panels isolated by session scope', () => {
    const store = useSidePanelStore.getState();

    store.setScope('session-a');
    store.openBrowserTab();
    store.setScope('session-b');

    expect(useSidePanelStore.getState().tabs).toEqual([]);

    store.openBrowserTab();
    expect(useSidePanelStore.getState().tabs[0]).toMatchObject({
      kind: 'browser',
      id: expect.stringMatching(/^session-b:browser:\d+$/),
    });

    store.setScope('session-a');
    expect(useSidePanelStore.getState().tabs[0]).toMatchObject({
      kind: 'browser',
      id: expect.stringMatching(/^session-a:browser:\d+$/),
    });
  });
});
