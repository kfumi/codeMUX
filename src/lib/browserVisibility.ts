import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { resolveEffectiveBrowserTabId } from './browserVisibilityPolicy';

import { subscribeOcclusionChanged } from './nativeViewOcclusion';

export { resolveEffectiveBrowserTabId } from './browserVisibilityPolicy';

export async function applyBrowserVisibility(requestedTabId: string | null = null) {
  const effectiveTabId = resolveEffectiveBrowserTabId(requestedTabId);
  await useBrowserStore.getState().syncGlobalBrowserVisibility(effectiveTabId);
}

export async function hideAllBrowserHosts() {
  await useBrowserStore.getState().hideAllBrowserHosts();
}

export function initBrowserVisibilitySync() {
  subscribeOcclusionChanged(() => {
    void applyBrowserVisibility(useSidePanelStore.getState().activeTabId);
  });

  let lastIsOpen = useSidePanelStore.getState().isOpen;
  let lastActiveTabId = useSidePanelStore.getState().activeTabId;
  let lastScopeId = useSidePanelStore.getState().activeScopeId;

  useSidePanelStore.subscribe((state) => {
    if (
      state.isOpen === lastIsOpen
      && state.activeTabId === lastActiveTabId
      && state.activeScopeId === lastScopeId
    ) {
      return;
    }
    lastIsOpen = state.isOpen;
    lastActiveTabId = state.activeTabId;
    lastScopeId = state.activeScopeId;
    void applyBrowserVisibility(state.activeTabId);
  });
}
