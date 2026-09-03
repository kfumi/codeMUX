import { useSidePanelStore } from '../stores/sidePanelStore';

export function resolveEffectiveBrowserTabId(requestedTabId: string | null): string | null {
  const sidePanel = useSidePanelStore.getState();
  if (!sidePanel.isOpen) return null;

  const activeTab = sidePanel.tabs.find((tab) => tab.id === sidePanel.activeTabId);
  if (!activeTab || activeTab.kind !== 'browser') return null;
  if (requestedTabId && requestedTabId !== activeTab.id) return null;
  return activeTab.id;
}
