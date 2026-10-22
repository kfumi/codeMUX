// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSessionFlowActive } from './useSessionFlowActive';
import { useAgentStore } from '../stores/agentStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useWorkTaskStore } from '../stores/workTaskStore';
import type { WorkTask, WorkTaskStatus } from '../types/workTask';

function makeTask(status: WorkTaskStatus, sessionId: string | null): WorkTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: '看板任务',
    instruction: '做事',
    agentKind: 'codex',
    providerId: null,
    model: null,
    useWorktree: false,
    baseBranch: null,
    workBranch: null,
    worktreePath: null,
    status,
    failureReason: null,
    lastError: null,
    runSeq: 0,
    sortOrder: 0,
    sessionId,
    resultSummary: null,
    filesChanged: null,
    additions: null,
    deletions: null,
    mergeCommit: null,
    completionKind: null,
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    settledAt: null,
    finishedAt: null,
  };
}

describe('useSessionFlowActive', () => {
  beforeEach(() => {
    useAgentStore.setState({ isRunning: {} });
    useSubagentStore.setState({ sessions: {}, continuationPending: {} });
    useWorkTaskStore.setState({ tasks: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('is idle when nothing is running', () => {
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(false);
  });

  it('is active while the parent turn is running', () => {
    useAgentStore.setState({ isRunning: { 'session-1': true } });
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(true);
  });

  it('is active for a running subagent of the session', () => {
    useSubagentStore.setState({
      sessions: {
        'session-1': {
          order: ['sub-1'],
          descriptors: {
            'sub-1': {
              subagentId: 'sub-1',
              provider: 'codex',
              status: 'running',
              updatedAt: 0,
            },
          },
          events: {},
          seenEventIds: {},
        },
      },
    });
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(true);
  });

  it('is active when the bound work task is still running', () => {
    useWorkTaskStore.setState({ tasks: [makeTask('running', 'session-1')] });
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(true);
  });

  it('is idle once the bound work task is done', () => {
    useWorkTaskStore.setState({ tasks: [makeTask('done', 'session-1')] });
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(false);
  });

  it('ignores work tasks bound to another session', () => {
    useWorkTaskStore.setState({ tasks: [makeTask('running', 'session-2')] });
    const { result } = renderHook(() => useSessionFlowActive('session-1'));
    expect(result.current).toBe(false);
  });
});
