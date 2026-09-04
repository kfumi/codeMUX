import { NEW_SESSION_DRAFT_SESSION_ID } from '../stores/newSessionStore';

export function browserScopeFromPanelTabId(panelTabId: string): string {
  const match = panelTabId.match(/^(.*):browser(?::\d+)?$/);
  return match?.[1] ?? 'global';
}

export function composerSessionIdForBrowserPanel(panelTabId: string): string {
  const scopeId = browserScopeFromPanelTabId(panelTabId);
  if (scopeId === 'home' || scopeId === 'global' || scopeId.startsWith('draft:')) {
    return NEW_SESSION_DRAFT_SESSION_ID;
  }
  return scopeId;
}
