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

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock('../../../hooks/useIsNarrowViewport', () => ({
  useIsNarrowViewport: () => narrowState.value,
}));

let mockState: Record<string, unknown>;
const sessionMock = vi.hoisted(() => ({ agentKind: 'pi' }));
const settingsMock = vi.hoisted(() => ({ mode: 'steer' as string }));

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockState),
}));

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: {
    sessions: Array<{ id: string; agent_kind: string }>;
    archivedSessions: Array<{ id: string; agent_kind: string }>;
  }) => unknown) => selector({
    sessions: [{ id: 'session-1', agent_kind: sessionMock.agentKind }],
    archivedSessions: [],
  }),
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: { immediate_run_mode?: string } | null }) => unknown) =>
    selector({ config: { immediate_run_mode: settingsMock.mode } }),
}));

vi.mock('../../ui/tooltip', () => ({
  TooltipHint: ({ content, children }: { content?: string; children: unknown }) => (
    <>
      {children}
      {content ? <span data-testid="run-now-hint">{content}</span> : null}
    </>
  ),
}));

import { QueuedMessages } from './QueuedMessages';

describe('QueuedMessages', () => {
  beforeEach(() => {
    sessionMock.agentKind = 'pi';
    settingsMock.mode = 'steer';
    narrowState.value = false;
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

  it('keeps the row actions fully opaque on narrow viewports (no hover on touch)', () => {
    narrowState.value = true;
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    const runNow = screen.getByLabelText('立即执行第 1 条排队消息');
    const cluster = runNow.parentElement as HTMLElement;
    expect(cluster.className).toContain('opacity-100');
    expect(cluster.className).not.toContain('opacity-70');
  });

  it('dims the row actions until hover on wide viewports', () => {
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    const runNow = screen.getByLabelText('立即执行第 1 条排队消息');
    const cluster = runNow.parentElement as HTMLElement;
    expect(cluster.className).toContain('opacity-70');
    expect(cluster.className).toContain('group-hover:opacity-100');
  });

  it('runs the chosen message immediately via the run-now button', () => {
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('立即执行第 2 条排队消息'));

    expect(runQueuedQueryNow).toHaveBeenCalledWith('session-1', 'q-2');
  });

  it('describes run-now as injecting the current turn when the agent can steer', () => {
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    expect(screen.getAllByTestId('run-now-hint')[0]?.textContent).toBe('注入当前轮并立即执行这条消息');
  });

  it('describes run-now as interrupting when the agent cannot steer', () => {
    sessionMock.agentKind = 'gemini_cli';
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    expect(screen.getAllByTestId('run-now-hint')[0]?.textContent).toBe('打断当前任务并立即执行这条消息');
  });

  it('describes run-now as interrupting when the user prefers interrupt', () => {
    settingsMock.mode = 'interrupt';
    render(<QueuedMessages sessionId="session-1" onEdit={vi.fn()} />);

    expect(screen.getAllByTestId('run-now-hint')[0]?.textContent).toBe('打断当前任务并立即执行这条消息');
  });
});
