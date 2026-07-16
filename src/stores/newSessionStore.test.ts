import { beforeEach, describe, expect, it } from 'vitest';

import { useNewSessionStore } from './newSessionStore';

describe('new session store', () => {
  beforeEach(() => {
    useNewSessionStore.setState({
      selectedAgentKind: 'claude_code',
      selectedModel: null,
      selectedReasoningEffort: 'medium',
      draftProjectId: null,
      isDraftOpen: false,
    });
  });

  it('defaults to Claude Code', () => {
    expect(useNewSessionStore.getState().selectedAgentKind).toBe('claude_code');
  });

  it('updates the draft agent independently from persisted sessions', () => {
    useNewSessionStore.getState().setSelectedAgentKind('codex');

    expect(useNewSessionStore.getState().selectedAgentKind).toBe('codex');
  });

  it('tracks and clears the draft model selection', () => {
    useNewSessionStore.getState().setSelectedModel('gpt-5');
    useNewSessionStore.getState().setSelectedReasoningEffort('high');

    expect(useNewSessionStore.getState().selectedModel).toBe('gpt-5');
    expect(useNewSessionStore.getState().selectedReasoningEffort).toBe('high');

    useNewSessionStore.getState().openDraft();
    expect(useNewSessionStore.getState().selectedModel).toBeNull();
    expect(useNewSessionStore.getState().selectedReasoningEffort).toBe('medium');
  });

  it('opens a global draft without a project', () => {
    useNewSessionStore.getState().openDraft();

    expect(useNewSessionStore.getState().isDraftOpen).toBe(true);
    expect(useNewSessionStore.getState().draftProjectId).toBeNull();
  });

  it('tracks and clears the project when closing a project draft', () => {
    useNewSessionStore.getState().openDraft('project-1');

    expect(useNewSessionStore.getState().isDraftOpen).toBe(true);
    expect(useNewSessionStore.getState().draftProjectId).toBe('project-1');

    useNewSessionStore.getState().closeDraft();

    expect(useNewSessionStore.getState().isDraftOpen).toBe(false);
    expect(useNewSessionStore.getState().draftProjectId).toBeNull();
  });
});
