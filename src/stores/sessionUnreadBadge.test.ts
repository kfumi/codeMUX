// 未读角标计数与焦点感知未读(工单 01/04/05)的 store 契约测试。
// 只断言外部行为:选择器返回什么数、动作之后集合里有什么。
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const focused = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/appActivity', () => ({
  isAppFocused: () => focused.value,
}));

const { deleteSessionMock, archiveMock } = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(async () => {}),
  archiveMock: vi.fn(async () => {}),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    deleteSession: deleteSessionMock,
    archiveViaDaemon: archiveMock,
    touchSession: vi.fn(async () => {}),
  },
}));

import { selectUnreadBadgeCount, useSessionStore } from './sessionStore';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    agent_kind: 'claude_code',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    project_id: null,
    is_archived: false,
    is_pinned: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function prime(sessions: Session[], unread: string[] = [], activeSessionId: string | null = null): void {
  useSessionStore.setState({
    sessions,
    archivedSessions: [],
    activeSessionId,
    unreadSessions: new Set(unread),
    autoMarkedUnreadSessions: new Set(),
    isLoading: false,
    isArchivedLoading: false,
    error: null,
  });
}

const countBadge = () => selectUnreadBadgeCount(useSessionStore.getState());

describe('selectUnreadBadgeCount', () => {
  beforeEach(() => {
    focused.value = true;
    vi.clearAllMocks();
  });

  it('只数仍在会话列表里的未读会话', () => {
    prime([session('a'), session('b')], ['a', 'b']);
    expect(countBadge()).toBe(2);
  });

  it('不数已不在列表里的残留 id(删除路径的兜底)', () => {
    prime([session('a')], ['a', 'ghost']);
    expect(countBadge()).toBe(1);
  });

  it('不数已归档的会话', () => {
    prime([session('a'), session('b', { is_archived: true })], ['a', 'b']);
    expect(countBadge()).toBe(1);
  });

  it('没有未读时是 0', () => {
    prime([session('a')], []);
    expect(countBadge()).toBe(0);
  });
});

describe('焦点感知的未读标记', () => {
  beforeEach(() => {
    focused.value = true;
    vi.clearAllMocks();
  });

  it('前台且正看着该会话时跳过标记', () => {
    prime([session('a')], [], 'a');

    useSessionStore.getState().markSessionUnread('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(false);
    expect(useSessionStore.getState().autoMarkedUnreadSessions.has('a')).toBe(false);
  });

  it('活跃会话但应用在后台时照样标未读,并记入后台补记集合', () => {
    focused.value = false;
    prime([session('a')], [], 'a');

    useSessionStore.getState().markSessionUnread('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(true);
    expect(useSessionStore.getState().autoMarkedUnreadSessions.has('a')).toBe(true);
    expect(countBadge()).toBe(1);
  });

  it('非活跃会话的未读不进后台补记集合(回焦不该自动清掉它)', () => {
    prime([session('a'), session('b')], [], 'a');

    useSessionStore.getState().markSessionUnread('b');

    expect(useSessionStore.getState().unreadSessions.has('b')).toBe(true);
    expect(useSessionStore.getState().autoMarkedUnreadSessions.has('b')).toBe(false);
  });
});

describe('回焦自动清除', () => {
  beforeEach(() => {
    focused.value = true;
    vi.clearAllMocks();
  });

  it('只清后台补记的未读', () => {
    focused.value = false;
    prime([session('a')], [], 'a');
    useSessionStore.getState().markSessionUnread('a');

    useSessionStore.getState().clearAutoMarkedUnread('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(false);
    expect(useSessionStore.getState().autoMarkedUnreadSessions.has('a')).toBe(false);
  });

  it('手动标记的未读不会被回焦清除', () => {
    prime([session('a')], [], null);
    useSessionStore.getState().markSessionUnread('a');

    useSessionStore.getState().clearAutoMarkedUnread('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(true);
    expect(countBadge()).toBe(1);
  });
});

describe('删除 / 归档时清理未读(工单 05)', () => {
  beforeEach(() => {
    focused.value = true;
    vi.clearAllMocks();
  });

  it('删除未读会话后计数减少', async () => {
    prime([session('a'), session('b')], ['a', 'b']);

    await useSessionStore.getState().deleteSession('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(false);
    expect(countBadge()).toBe(1);
  });

  it('批量移除被删除的会话时同步清理未读', () => {
    prime([session('a'), session('b')], ['a', 'b']);

    useSessionStore.getState().removeDeletedSessions(['a', 'b']);

    expect(useSessionStore.getState().unreadSessions.size).toBe(0);
    expect(countBadge()).toBe(0);
  });

  it('归档未读会话后计数减少', async () => {
    prime([session('a'), session('b')], ['a', 'b']);

    await useSessionStore.getState().archiveSession('a');

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(false);
    expect(countBadge()).toBe(1);
  });

  it('删除非未读会话不影响计数', async () => {
    prime([session('a'), session('b')], ['b']);

    await useSessionStore.getState().deleteSession('a');

    expect(countBadge()).toBe(1);
  });
});
