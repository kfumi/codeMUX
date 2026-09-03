// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import {
  applyBrowserVisibility,
  hideAllBrowserHosts,
  initBrowserVisibilitySync,
} from './browserVisibility';
import { resolveEffectiveBrowserTabId } from './browserVisibilityPolicy';
import { clearOccluders } from './nativeViewOcclusion';

const browserApiMock = vi.hoisted(() => ({
  hide: vi.fn(),
}));

vi.mock('../lib/tauri', () => ({
  browserApi: browserApiMock,
}));

describe('browserVisibility', () => {
  beforeEach(() => {
    useBrowserStore.getState().reset();
    clearOccluders();
    useSidePanelStore.setState({
      isOpen: false,
      tabs: [],
      activeTabId: null,
    });
    browserApiMock.hide.mockReset();
    browserApiMock.hide.mockResolvedValue(undefined);
  });

  it('returns null when the side panel is closed', () => {
    useSidePanelStore.setState({
      isOpen: true,
      tabs: [{ id: 'scope:browser:1', kind: 'browser', title: 'Browser' }],
      activeTabId: 'scope:browser:1',
    });
    useSidePanelStore.setState({ isOpen: false });

    expect(resolveEffectiveBrowserTabId('scope:browser:1')).toBeNull();
  });

  it('ignores stale tab ids after the panel closes', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser:1');
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: { ...state.pages[pageId], hostAttached: true },
      },
    }));
    useSidePanelStore.setState({
      isOpen: true,
      tabs: [{ id: 'scope:browser:1', kind: 'browser', title: 'Browser' }],
      activeTabId: 'scope:browser:1',
    });
    useSidePanelStore.setState({ isOpen: false });

    await applyBrowserVisibility('scope:browser:1');

    expect(browserApiMock.hide).toHaveBeenCalledWith(pageId);
    expect(browserApiMock.hide).toHaveBeenCalled();
  });

  it('hides all hosts when hideAllBrowserHosts is called', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser:1');
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: { ...state.pages[pageId], hostAttached: true },
      },
    }));

    await hideAllBrowserHosts();

    expect(browserApiMock.hide).toHaveBeenCalledWith(pageId);
  });

  it('syncs visibility when the side panel closes via subscription', async () => {
    const pageId = useBrowserStore.getState().ensureBlankPage('scope:browser:1');
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: { ...state.pages[pageId], hostAttached: true },
      },
    }));
    useSidePanelStore.setState({
      isOpen: true,
      tabs: [{ id: 'scope:browser:1', kind: 'browser', title: 'Browser' }],
      activeTabId: 'scope:browser:1',
    });

    initBrowserVisibilitySync();
    useSidePanelStore.setState({ isOpen: false });
    await Promise.resolve();

    expect(browserApiMock.hide).toHaveBeenCalledWith(pageId);
  });
});
