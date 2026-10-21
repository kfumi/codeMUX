// @vitest-environment jsdom
// 未读角标 hook 契约测试(工单 01/04):计数变化才同步壳、计数不变不发包、
// 回焦只清后台补记的未读、无壳桥时静默降级。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const focused = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/appActivity', () => ({
  isAppFocused: () => focused.value,
}));

const { syncUnreadBadgeCountMock } = vi.hoisted(() => ({
  syncUnreadBadgeCountMock: vi.fn(async () => {}),
}));

vi.mock('../lib/facades/shell-facade', () => ({
  shellFacade: {
    syncUnreadBadgeCount: syncUnreadBadgeCountMock,
  },
}));

const badgeCapability = vi.hoisted(() => ({ available: true }));
vi.mock('./useHostCapabilities', () => ({
  useHostCapabilities: () => ({
    has: (id: string) => id === 'notification.badge' && badgeCapability.available,
  }),
}));

import { useSessionStore } from '../stores/sessionStore';
import { useUnreadBadge } from './useUnreadBadge';

function session(id: string): Session {
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
  };
}

function prime(sessions: Session[], unread: string[] = [], activeSessionId: string | null = null): void {
  useSessionStore.setState({
    sessions,
    archivedSessions: [],
    activeSessionId,
    unreadSessions: new Set(unread),
    autoMarkedUnreadSessions: new Set(),
  });
}

function Harness() {
  useUnreadBadge();
  return null;
}

describe('useUnreadBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focused.value = true;
    badgeCapability.available = true;
    syncUnreadBadgeCountMock.mockImplementation(async () => {});
    prime([session('a')]);
  });

  afterEach(() => {
    cleanup();
  });

  it('挂载时把当前计数同步给壳', () => {
    prime([session('a')], ['a']);

    render(<Harness />);

    expect(syncUnreadBadgeCountMock).toHaveBeenCalledWith(1);
  });

  it('计数变化才发包,重复渲染不发', () => {
    prime([session('a')], []);
    const { rerender } = render(<Harness />);
    expect(syncUnreadBadgeCountMock).toHaveBeenCalledWith(0);

    rerender(<Harness />);
    expect(syncUnreadBadgeCountMock).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.setState({ unreadSessions: new Set(['a']) });
    });
    expect(syncUnreadBadgeCountMock).toHaveBeenLastCalledWith(1);
    expect(syncUnreadBadgeCountMock).toHaveBeenCalledTimes(2);
  });

  it('浏览器形态(无该能力)时根本不发同步,也不报错', () => {
    badgeCapability.available = false;

    expect(() => render(<Harness />)).not.toThrow();
    expect(syncUnreadBadgeCountMock).not.toHaveBeenCalled();
  });

  it('壳桥拒绝时静默降级,不抛出也不重试', async () => {
    syncUnreadBadgeCountMock.mockImplementation(async () => {
      throw new Error('codemuxDesktop 桥不可用');
    });

    expect(() => render(<Harness />)).not.toThrow();
    // 让 rejection 走完一轮微任务,确认没有未处理拒绝冒出来。
    await act(async () => {
      await Promise.resolve();
    });
    expect(syncUnreadBadgeCountMock).toHaveBeenCalledTimes(1);
  });

  it('回焦时清掉当前会话的后台补记未读', () => {
    focused.value = false;
    prime([session('a')], [], 'a');
    useSessionStore.getState().markSessionUnread('a');
    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(true);

    render(<Harness />);

    focused.value = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(false);
    expect(useSessionStore.getState().autoMarkedUnreadSessions.has('a')).toBe(false);
  });

  it('回焦时不清手动标记的未读', () => {
    prime([session('a'), session('b')], [], 'a');
    useSessionStore.getState().markSessionUnread('b');

    render(<Harness />);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useSessionStore.getState().unreadSessions.has('b')).toBe(true);
  });

  it('回焦时若已切到别的会话,保留原会话的未读', () => {
    focused.value = false;
    prime([session('a'), session('b')], [], 'a');
    useSessionStore.getState().markSessionUnread('a');
    // 用户离开期间去看过别的会话(切过去会清掉 b 的未读,但 a 的未读保留)。
    useSessionStore.getState().setActiveSession('b');

    render(<Harness />);

    focused.value = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useSessionStore.getState().unreadSessions.has('a')).toBe(true);
  });
});
