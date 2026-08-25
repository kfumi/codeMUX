// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedAgentQuery } from '../../../types/agentQueue';

const runQueuedQueryNow = vi.fn();
const removeQueuedQuery = vi.fn();
const reorderQueuedQuery = vi.fn();
const resumeQueuedQueries = vi.fn();
const clearQueuedQueries = vi.fn();

const queries: QueuedAgentQuery[] = [
  { id: 'q-1', prompt: 'first task', cwd: 'D:\\workspace', createdAt: 1 },
  { id: 'q-2', prompt: 'second task', cwd: 'D:\\workspace', createdAt: 2 },
];

let mockState: Record<string, unknown>;

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockState),
}));

import { QueuedMessages } from './QueuedMessages';

describe('QueuedMessages', () => {
  beforeEach(() => {
    mockState = {
      queuedQueries: { 'session-1': queries },
      queuePaused: { 'session-1': false },
      removeQueuedQuery,
      reorderQueuedQuery,
      resumeQueuedQueries,
      clearQueuedQueries,
      runQueuedQueryNow,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders queued messages with their row actions', () => {
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    expect(screen.getByText('排队消息')).toBeTruthy();
    expect(screen.getByTestId('queued-message-0').textContent).toContain('first task');
    expect(screen.getByLabelText('编辑第 1 条排队消息')).toBeTruthy();
    expect(screen.getByLabelText('删除第 2 条排队消息')).toBeTruthy();
  });

  it('runs the chosen message immediately via the run-now button', () => {
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('立即执行第 2 条排队消息'));

    expect(runQueuedQueryNow).toHaveBeenCalledWith('session-1', 'q-2');
  });
});
