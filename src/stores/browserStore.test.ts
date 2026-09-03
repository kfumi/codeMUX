import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserApiMock = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reload: vi.fn(),
  setBounds: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  evaluate: vi.fn(),
  openDevtools: vi.fn(),
  clearData: vi.fn(),
  setZoom: vi.fn(),
}));

vi.mock('../lib/tauri', () => ({
  browserApi: browserApiMock,
}));

import { useBrowserStore } from './browserStore';
import { useSidePanelStore } from './sidePanelStore';
import { clearOccluders, registerOccluder, unregisterOccluder } from '../lib/nativeViewOcclusion';

const PANEL_BOUNDS = { x: 10, y: 20, width: 800, height: 900 };

function openBrowserSidePanel(panelTabId: string) {
  useSidePanelStore.setState({
    isOpen: true,
    tabs: [{ id: panelTabId, kind: 'browser', title: 'Browser' }],
    activeTabId: panelTabId,
  });
}

async function attachPage(panelTabId: string, url = 'https://example.com/') {
  const pageId = useBrowserStore.getState().ensureBlankPage(panelTabId);
  await useBrowserStore.getState().setPanelBounds(panelTabId, PANEL_BOUNDS);
  await useBrowserStore.getState().navigate(pageId, url);
  return pageId;
}

describe('browser store', () => {
  beforeEach(() => {
    useBrowserStore.getState().reset();
    clearOccluders();
    useSidePanelStore.setState({
      isOpen: false,
      tabs: [],
      activeTabId: null,
    });
    for (const fn of Object.values(browserApiMock)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  it('creates a blank page without contacting the host', () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser');
    const page = useBrowserStore.getState().pages[pageId];

    expect(page).toMatchObject({
      url: '',
      addressDraft: '',
      hostAttached: false,
      lastError: null,
    });
    expect(browserApiMock.create).not.toHaveBeenCalled();
  });

  it('reuses the existing blank page for the same panel', () => {
    const first = useBrowserStore.getState().ensureBlankPage('scope:browser');
    const second = useBrowserStore.getState().ensureBlankPage('scope:browser');
    expect(second).toBe(first);
  });

  it('navigates through the host after adding https', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser');
    await useBrowserStore.getState().setPanelBounds('scope:browser', PANEL_BOUNDS);
    await useBrowserStore.getState().navigate(pageId, 'example.com/docs');

    expect(browserApiMock.create).toHaveBeenCalledWith(
      pageId,
      'https://example.com/docs',
      PANEL_BOUNDS,
    );
    expect(useBrowserStore.getState().pages[pageId].hostAttached).toBe(true);
    expect(useBrowserStore.getState().pages[pageId].lastError).toBeNull();
  });

  it('waits for usable panel bounds before creating a host page', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser');
    await useBrowserStore.getState().navigate(pageId, 'https://example.com/docs');

    expect(browserApiMock.create).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().pages[pageId].hostAttached).toBe(false);

    await useBrowserStore.getState().setPanelBounds('scope:browser', PANEL_BOUNDS);

    expect(browserApiMock.create).toHaveBeenCalledWith(
      pageId,
      'https://example.com/docs',
      PANEL_BOUNDS,
    );
    expect(useBrowserStore.getState().pages[pageId].hostAttached).toBe(true);
  });

  it('records lastError for non-http schemes without calling the host', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser');
    await useBrowserStore.getState().navigate(pageId, 'file:///tmp/index.html');

    expect(browserApiMock.create).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().pages[pageId].lastError).toBe('只允许 http 或 https 地址');
    expect(useBrowserStore.getState().pages[pageId].hostAttached).toBe(false);
  });

  it('destroys an attached page and reports an empty panel when closing the last page', async () => {
    const pageId = await attachPage('scope:browser');
    const result = await useBrowserStore.getState().closePage(pageId);

    expect(browserApiMock.destroy).toHaveBeenCalledWith(pageId);
    expect(result).toEqual({ panelEmpty: true, panelTabId: 'scope:browser' });
    expect(useBrowserStore.getState().pageIdsByPanel['scope:browser']).toEqual([]);
  });

  it('applies host patches onto the page title and navigation flags', () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser');
    useBrowserStore.getState().applyHostPatch({
      browserId: pageId,
      title: 'Example',
      url: 'https://example.com/',
      canGoBack: true,
      isLoading: false,
    });

    expect(useBrowserStore.getState().pages[pageId]).toMatchObject({
      title: 'Example',
      url: 'https://example.com/',
      addressDraft: 'https://example.com/',
      canGoBack: true,
      isLoading: false,
    });
  });

  it('hides every attached page when the side panel has no active browser tab', async () => {
    const firstPageId = await attachPage('scope:browser:1');
    const secondPageId = await attachPage('scope:browser:2');
    browserApiMock.hide.mockClear();

    await useBrowserStore.getState().syncGlobalBrowserVisibility(null);

    expect(browserApiMock.hide).toHaveBeenCalledWith(firstPageId);
    expect(browserApiMock.hide).toHaveBeenCalledWith(secondPageId);
    expect(browserApiMock.show).not.toHaveBeenCalled();
  });

  it('shows only the active browser tab page', async () => {
    const visiblePageId = await attachPage('scope:browser:1');
    await attachPage('scope:browser:2');
    openBrowserSidePanel('scope:browser:1');
    browserApiMock.show.mockClear();
    browserApiMock.hide.mockClear();

    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');

    expect(browserApiMock.show).toHaveBeenCalledWith(visiblePageId);
    expect(browserApiMock.hide).toHaveBeenCalled();
  });

  it('deduplicates concurrent host creation for the same page', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser:1');
    await useBrowserStore.getState().setPanelBounds('scope:browser:1', PANEL_BOUNDS);
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: {
          ...state.pages[pageId],
          url: 'https://example.com/',
          addressDraft: 'https://example.com/',
        },
      },
    }));

    let resolveCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    browserApiMock.create.mockImplementation(async () => {
      await createGate;
    });

    const layoutCreate = useBrowserStore.getState().setPanelBounds('scope:browser:1', PANEL_BOUNDS);
    const navigateCreate = useBrowserStore.getState().navigate(pageId, 'https://example.com/');
    resolveCreate?.();
    await Promise.all([layoutCreate, navigateCreate]);

    expect(browserApiMock.create).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().pages[pageId].hostAttached).toBe(true);
  });

  it('recovers when the native host already exists', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser:1');
    await useBrowserStore.getState().setPanelBounds('scope:browser:1', PANEL_BOUNDS);
    browserApiMock.create.mockRejectedValueOnce(new Error("a webview with label 'cmx-b-test' already exists"));

    await useBrowserStore.getState().navigate(pageId, 'https://example.com/docs');

    expect(useBrowserStore.getState().pages[pageId]).toMatchObject({
      hostAttached: true,
      lastError: null,
    });
  });

  it('hides browser webviews while a native occluder overlaps the host bounds', async () => {
    const visiblePageId = await attachPage('scope:browser:1');
    openBrowserSidePanel('scope:browser:1');
    await useBrowserStore.getState().setPanelBounds('scope:browser:1', { x: 100, y: 200, width: 400, height: 300 });
    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');
    browserApiMock.show.mockClear();
    browserApiMock.hide.mockClear();

    registerOccluder('menu', { x: 120, y: 220, width: 80, height: 120 });
    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');

    expect(browserApiMock.show).not.toHaveBeenCalled();
    expect(browserApiMock.hide).toHaveBeenCalledWith(visiblePageId);

    unregisterOccluder('menu');
    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');
    expect(browserApiMock.show).toHaveBeenCalledWith(visiblePageId);
  });

  it('hides browser webviews while a dropdown menu is open', async () => {
    const visiblePageId = await attachPage('scope:browser:1');
    openBrowserSidePanel('scope:browser:1');
    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');
    browserApiMock.show.mockClear();
    browserApiMock.hide.mockClear();
    browserApiMock.setBounds.mockClear();

    useBrowserStore.getState().beginNativeMenuOpen();

    expect(browserApiMock.show).not.toHaveBeenCalled();
    expect(browserApiMock.hide).toHaveBeenCalledWith(visiblePageId);

    useBrowserStore.getState().endNativeMenuOpen();
    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');
    expect(browserApiMock.setBounds).toHaveBeenCalled();
    expect(browserApiMock.show).toHaveBeenCalledWith(visiblePageId);
  });

  it('does not show webviews when the side panel is closed', async () => {
    const pageId = await attachPage('scope:browser:1');
    openBrowserSidePanel('scope:browser:1');
    browserApiMock.show.mockClear();
    browserApiMock.hide.mockClear();
    useSidePanelStore.setState({ isOpen: false });

    await useBrowserStore.getState().syncGlobalBrowserVisibility('scope:browser:1');

    expect(browserApiMock.show).not.toHaveBeenCalled();
    expect(browserApiMock.hide).toHaveBeenCalledWith(pageId);
  });

  it('hides attached pages that are not the visible page', async () => {
    const pageId = await attachPage('scope:browser');
    browserApiMock.show.mockClear();
    await useBrowserStore.getState().syncVisibility('scope:browser', null);

    expect(browserApiMock.hide).toHaveBeenCalledWith(pageId);
    expect(browserApiMock.show).not.toHaveBeenCalled();
  });

  it('ends inspect mode when the page starts navigating', async () => {
    const pageId = await attachPage('scope:browser');
    useBrowserStore.getState().startInspect(pageId);
    await useBrowserStore.getState().navigate(pageId, 'https://example.com/docs');

    expect(useBrowserStore.getState().inspectingPageId).toBeNull();
    expect(browserApiMock.navigate).toHaveBeenCalledWith(pageId, 'https://example.com/docs');
  });

  it('ends inspect mode when the inspecting page is hidden', async () => {
    const pageId = await attachPage('scope:browser');
    useBrowserStore.getState().startInspect(pageId);
    await useBrowserStore.getState().syncVisibility('scope:browser', null);

    expect(useBrowserStore.getState().inspectingPageId).toBeNull();
  });

  it('applies viewport bounds immediately when the mode changes', async () => {
    const pageId = await attachPage('scope:browser');
    browserApiMock.setBounds.mockClear();

    await useBrowserStore.getState().setViewportPreview('scope:browser', true);
    await useBrowserStore.getState().setViewportMode('scope:browser', 100);

    expect(browserApiMock.setBounds).toHaveBeenCalledWith(
      pageId,
      expect.objectContaining({ width: 393, height: 852 }),
    );
    expect(useBrowserStore.getState().viewportModeByPanel['scope:browser']).toBe(100);
  });

  it('applies the reference viewport when free-size preview is enabled', async () => {
    const pageId = await attachPage('scope:browser');
    browserApiMock.setBounds.mockClear();

    await useBrowserStore.getState().setViewportPreview('scope:browser', true);

    expect(useBrowserStore.getState().previewByPanel['scope:browser']).toBe(true);
    expect(browserApiMock.setBounds).toHaveBeenCalledWith(
      pageId,
      expect.objectContaining({ width: 393, height: 852 }),
    );
  });

  it('scales the reference viewport when a percentage is selected', async () => {
    const pageId = await attachPage('scope:browser');
    await useBrowserStore.getState().setViewportPreview('scope:browser', true);
    browserApiMock.setBounds.mockClear();

    await useBrowserStore.getState().setViewportMode('scope:browser', 50);

    expect(browserApiMock.setBounds).toHaveBeenCalledWith(
      pageId,
      expect.objectContaining({ width: 197, height: 426 }),
    );
  });

  it('re-applies viewport bounds after layout updates', async () => {
    const pageId = await attachPage('scope:browser');
    await useBrowserStore.getState().setViewportPreview('scope:browser', true);
    await useBrowserStore.getState().setViewportMode('scope:browser', 100);
    await useBrowserStore.getState().setPanelBounds('scope:browser', PANEL_BOUNDS);

    expect(browserApiMock.setBounds).toHaveBeenCalledWith(
      pageId,
      expect.objectContaining({ width: 393, height: 852 }),
    );
    expect(useBrowserStore.getState().viewportModeByPanel['scope:browser']).toBe(100);
  });
});
