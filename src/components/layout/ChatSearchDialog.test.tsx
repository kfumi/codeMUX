// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findShortcutCommand,
  keybindingDisplayParts,
  resolveKeybinding,
} from '../../lib/shortcuts/keyboardShortcuts';
import { getShortcutPlatform } from '../../lib/shortcuts/shortcutPlatform';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useShortcutCommandStore } from '../../stores/shortcutCommandStore';
import type { Session } from '../../types/session';
import type { AppConfig } from '../../types/provider';
import { ChatSearchDialog } from './ChatSearchDialog';

const { getTimelineMock } = vi.hoisted(() => ({
  getTimelineMock: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    getTimeline: getTimelineMock,
  },
}));

const scrollIntoViewSpy = vi.fn();
const scrollTargets: Element[] = [];

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
      onSelectSession={vi.fn()}
      {...props}
    />,
  );
}

describe('ChatSearchDialog', () => {
  beforeEach(() => {
    getTimelineMock.mockReset();
    getTimelineMock.mockResolvedValue({ events: [], hasMore: false });

    // jsdom 不实现布局：只记录 scrollIntoView 调用，不断言几何。
    scrollIntoViewSpy.mockReset();
    scrollTargets.length = 0;
    Element.prototype.scrollIntoView = function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrollTargets.push(this);
      scrollIntoViewSpy(options);
    } as typeof Element.prototype.scrollIntoView;

    useSettingsStore.setState({ config: null });
    useShortcutCommandStore.setState({ handlers: {} });

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

  it('uses the shared dialog surface background', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('shadow-[0_18px_46px_-30px_hsl(var(--surface-shadow-strong)/0.82)]');
    expect(dialog.className).toContain('border-[hsl(var(--surface-edge))]/90');
    expect(dialog.className).toContain('bg-background');
    expect(dialog.className).toContain('dark:bg-[hsl(var(--surface-3))]');
    expect(dialog.className.split(/\s+/)).not.toContain('bg-[hsl(var(--surface-3))]');
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
    getTimelineMock.mockImplementation((sessionId: string) => Promise.resolve(
      sessionId === 'preview-hit'
        ? {
            events: [{
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'text', text: '梳理 Node 依赖并评估内置方案' }],
              },
            }],
            hasMore: false,
          }
        : { events: [], hasMore: false },
    ));

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('梳理 Node 依赖并评估内置方案')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: 'Node 依赖' } });

    expect(screen.getByText('Untitled')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('selects a result by click and delegates session navigation', () => {
    const onSelectSession = vi.fn();
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

    renderDialog({ onSelectSession, onOpenChange });

    fireEvent.click(screen.getByText('Target chat'));

    expect(onSelectSession).toHaveBeenCalledWith('target', 'project-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('supports keyboard navigation and enter selection', () => {
    const onOpenChange = vi.fn();
    const onSelectSession = vi.fn();
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'first', title: 'First chat', updated_at: '2026-01-03T00:00:00.000Z' }),
        makeSession({ id: 'second', title: 'Second chat', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });

    renderDialog({ onOpenChange, onSelectSession });

    const input = screen.getByPlaceholderText('搜索聊天或运行命令');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectSession).toHaveBeenCalledWith('second', null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps sessions with no history searchable by title', async () => {
    getTimelineMock.mockResolvedValue({ events: [], hasMore: false });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'empty-history', title: 'No history yet', updated_at: '2026-01-03T00:00:00.000Z' }),
      ],
    });

    renderDialog();

    await waitFor(() => {
      expect(getTimelineMock).toHaveBeenCalledWith('empty-history', { direction: 'tail', limit: 200 });
    });

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: 'history' } });

    expect(screen.getByText('No history yet')).toBeTruthy();
  });

  it('lists an available command with its current keybinding when the query matches', () => {
    useShortcutCommandStore.setState({ handlers: { openSettings: vi.fn() } });

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: '打开设置' } });

    expect(screen.getByText('命令')).toBeTruthy();
    expect(screen.getByText('打开设置')).toBeTruthy();

    const platform = getShortcutPlatform();
    const binding = resolveKeybinding(findShortcutCommand('openSettings'), undefined, platform);
    expect(binding).toBeTruthy();
    for (const part of keybindingDisplayParts(binding, platform)) {
      expect(screen.getAllByText(part).length).toBeGreaterThan(0);
    }
  });

  it('runs the selected command on enter and closes the dialog', () => {
    const openSettingsHandler = vi.fn();
    const toggleSidebarHandler = vi.fn();
    useShortcutCommandStore.setState({
      handlers: { openSettings: openSettingsHandler, toggleSidebar: toggleSidebarHandler },
    });
    useSessionStore.setState({ sessions: [] });
    const onOpenChange = vi.fn();
    const onSelectSession = vi.fn();

    renderDialog({ onOpenChange, onSelectSession });

    const input = screen.getByPlaceholderText('搜索聊天或运行命令');
    fireEvent.change(input, { target: { value: '打开设置' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(openSettingsHandler).toHaveBeenCalledTimes(1);
    expect(toggleSidebarHandler).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not list a command whose handler is not registered', () => {
    useShortcutCommandStore.setState({ handlers: { toggleSidebar: vi.fn() } });

    renderDialog();

    expect(screen.getByText('折叠/展开侧边栏')).toBeTruthy();
    expect(screen.queryByText('打开设置')).toBeNull();
  });

  it('navigates from the session section into commands as one flat list', () => {
    const toggleSidebarHandler = vi.fn();
    useShortcutCommandStore.setState({ handlers: { toggleSidebar: toggleSidebarHandler } });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'only-session', title: 'Only chat', updated_at: '2026-01-03T00:00:00.000Z' }),
      ],
    });
    const onOpenChange = vi.fn();
    const onSelectSession = vi.fn();

    renderDialog({ onOpenChange, onSelectSession });

    const input = screen.getByPlaceholderText('搜索聊天或运行命令');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(toggleSidebarHandler).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders an explicitly disabled command as 已禁用 instead of 未绑定', () => {
    useShortcutCommandStore.setState({ handlers: { openSettings: vi.fn() } });
    useSettingsStore.setState({
      config: { keybindings: { openSettings: null } } as unknown as AppConfig,
    });

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('搜索聊天或运行命令'), { target: { value: '打开设置' } });

    expect(screen.getByText('打开设置')).toBeTruthy();
    expect(screen.getByText('已禁用')).toBeTruthy();
    expect(screen.queryByText('未绑定')).toBeNull();
  });

  it('scrolls the selected row into view when keyboard navigation moves past the fold', () => {
    useShortcutCommandStore.setState({
      handlers: { openSettings: vi.fn(), toggleSidebar: vi.fn() },
    });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'first', title: 'First chat', updated_at: '2026-01-03T00:00:00.000Z' }),
        makeSession({ id: 'second', title: 'Second chat', updated_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });

    renderDialog();

    const input = screen.getByPlaceholderText('搜索聊天或运行命令');
    scrollIntoViewSpy.mockClear();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    const selectedRow = document.querySelector('[data-selected="true"]');
    expect(selectedRow).not.toBeNull();
    expect(scrollTargets.at(-1)).toBe(selectedRow);
  });
});
