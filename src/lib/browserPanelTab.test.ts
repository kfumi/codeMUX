import { describe, expect, it } from 'vitest';

import { browserScopeFromPanelTabId, composerSessionIdForBrowserPanel } from './browserPanelTab';
import { NEW_SESSION_DRAFT_SESSION_ID } from '../stores/newSessionStore';

describe('browserPanelTab', () => {
  it('extracts the scope from legacy and sequenced browser tab ids', () => {
    expect(browserScopeFromPanelTabId('session-a:browser')).toBe('session-a');
    expect(browserScopeFromPanelTabId('session-a:browser:3')).toBe('session-a');
  });

  it('maps draft and global scopes to the composer draft session id', () => {
    expect(composerSessionIdForBrowserPanel('global:browser:1')).toBe(NEW_SESSION_DRAFT_SESSION_ID);
    expect(composerSessionIdForBrowserPanel('draft:foo:browser:2')).toBe(NEW_SESSION_DRAFT_SESSION_ID);
    expect(composerSessionIdForBrowserPanel('session-a:browser:1')).toBe('session-a');
  });
});
