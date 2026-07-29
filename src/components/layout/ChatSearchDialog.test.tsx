// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types/session';
import { ChatSearchDialog } from './ChatSearchDialog';

const { loadClaudeSessionEventsMock, loadCodexSessionEventsMock } = vi.hoisted(() => ({
  loadClaudeSessionEventsMock: vi.fn(),
  loadCodexSessionEventsMock: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    loadClaudeSessionEvents: loadClaudeSessionEventsMock,
    loadCodexSessionEvents: loadCodexSessionEventsMock,
  },
}));

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'title' | 'updated_at'>): Session {
  return {
    agent_kind: 'claude_code',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    project_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    is_archived: false,
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof ChatSearchDialog>> = {}) {
  return render(
    <ChatSearchDialog
      open
      onOpenChange={vi.fn()}
      onNavigateHome={vi.fn()}
      {...props}
    />,
  );
}

describe('ChatSearchDialog', () => {
  beforeEach(() => {
    loadClaudeSessionEventsMock.mockReset();
    loadCodexSessionEventsMock.mockReset();
    loadClaudeSessionEventsMock.mockResolvedValue([]);
    loadCodexSessionEventsMock.mockResolvedValue([]);

    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'older', title: 'Older chat', updated_at: '2026-01-01T00:00:00.000Z' }),
        makeSession({ id: 'newer', title: 'Newer chat', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
      activeSessionId: null,
      unreadSessions: new Set(),
    });

    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders recent sessions when the query is empty', () => {
    renderDialog();

    const newer = screen.getByText('Newer chat');
    const older = screen.getByText('Older chat');

    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not use a bright oversized shadow for the dark-theme search window', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('shadow-[0_18px_46px_-30px_hsl(var(--surface-shadow-strong)/0.82)]');
    expect(dialog.className).toContain('border-[hsl(var(--surface-edge))]/90');
    expect(dialog.className).toContain('bg-[hsl(var(--surface-3))]');
    expect(dialog.className).not.toContain('0_28px_80px_-42px_hsl(var(--foreground)');
  });

  it('filters sessions by title and project name', async () => {
    useProjectStore.setState({
      projects: [{
        id: 'project-1',
        name: 'codeMUX',
        path: 'D:\\project\\ai-code\\codeMUX',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'review', title: '审查 streaming-thinking-performance', project_id: 'project-1', updated_at: '2026-01-03T00:00:00.000Z' }),
        makeSession({ id: 'other', title: 'Fix sidebar polish', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: '审查' } });
    expect(screen.getByText('审查 streaming-thinking-performance')).toBeTruthy();
    expect(screen.queryByText('Fix sidebar polish')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: 'codemux' } });
    expect(screen.getByText('审查 streaming-thinking-performance')).toBeTruthy();
    expect(screen.getByText('codeMUX')).toBeTruthy();
  });

  it('filters by the loaded first user message preview', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'preview-hit', title: 'Untitled', updated_at: '2026-01-03T00:00:00.000Z' }),
        makeSession({ id: 'preview-miss', title: 'Other', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    loadClaudeSessionEventsMock.mockImplementation((sessionId: string) => Promise.resolve(
      sessionId === 'preview-hit'
        ? [{
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '梳理 Node 依赖并评估内置方案' }],
            },
          }]
        : [],
    ));

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('梳理 Node 依赖并评估内置方案')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: 'Node 依赖' } });

    expect(screen.getByText('Untitled')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('selects a result by click and updates active session and project', () => {
    const onNavigateHome = vi.fn();
    const onOpenChange = vi.fn();
    useProjectStore.setState({
      projects: [{
        id: 'project-1',
        name: 'codeMUX',
        path: 'D:\\project\\ai-code\\codeMUX',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'target', title: 'Target chat', project_id: 'project-1', updated_at: '2026-01-03T00:00:00.000Z' }),
      ],
    });

    renderDialog({ onNavigateHome, onOpenChange });

    fireEvent.click(screen.getByText('Target chat'));

    expect(useSessionStore.getState().activeSessionId).toBe('target');
    expect(useProjectStore.getState().activeProjectId).toBe('project-1');
    expect(onNavigateHome).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('supports keyboard navigation and enter selection', () => {
    const onOpenChange = vi.fn();
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'first', title: 'First chat', updated_at: '2026-01-03T00:00:00.000Z' }),
        makeSession({ id: 'second', title: 'Second chat', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });

    renderDialog({ onOpenChange });

    const input = screen.getByPlaceholderText('搜索聊天或运行命令');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useSessionStore.getState().activeSessionId).toBe('second');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps sessions with no history searchable by title', async () => {
    loadClaudeSessionEventsMock.mockResolvedValue([]);
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'empty-history', title: 'No history yet', updated_at: '2026-01-03T00:00:00.000Z' }),
      ],
    });

    renderDialog();

    await waitFor(() => {
      expect(loadClaudeSessionEventsMock).toHaveBeenCalledWith('empty-history');
    });

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: 'history' } });

    expect(screen.getByText('No history yet')).toBeTruthy();
  });
});
