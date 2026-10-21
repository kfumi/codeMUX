import { useEffect } from 'react';

import { isAppFocused } from '../lib/appActivity';
import { shellFacade } from '../lib/facades/shell-facade';
import { selectUnreadBadgeCount, useSessionStore } from '../stores/sessionStore';
import { useHostCapabilities } from './useHostCapabilities';

/**
 * 桌面未读角标(工单 01/04;spec docs/specs/2026-10-21-desktop-unread-badge.md)。
 *
 * 两件事:
 * 1. 把未读对话数同步给壳(任务栏 / 托盘角标),计数不变不发包;
 * 2. 窗口重新获得焦点时,若仍停在那个「后台跑完」的会话上,自动清掉它的未读 ——
 *    不让蓝点卡在一个用户正看着的会话上。
 *
 * 浏览器 / 移动形态没有任务栏:按宿主能力清单直接跳过同步,而不是发一个
 * 必然被拒绝的调用再吞错。
 */
export function useUnreadBadge(): void {
  const capabilities = useHostCapabilities();
  const badgeAvailable = capabilities.has('notification.badge');
  const unreadCount = useSessionStore(selectUnreadBadgeCount);

  useEffect(() => {
    if (!badgeAvailable) return;
    void shellFacade.syncUnreadBadgeCount(unreadCount).catch(() => {
      // 壳桥在页面生命周期内不变;真拒绝(如 preload 未注入)时静默跳过,
      // 与壳门面其他能力的降级约定一致:角标失败不该冒到错误边界。
    });
  }, [badgeAvailable, unreadCount]);

  useEffect(() => {
    const handleFocus = () => {
      if (!isAppFocused()) return;
      const { activeSessionId, autoMarkedUnreadSessions, clearAutoMarkedUnread } = useSessionStore.getState();
      if (activeSessionId && autoMarkedUnreadSessions.has(activeSessionId)) {
        clearAutoMarkedUnread(activeSessionId);
      }
    };

    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, []);
}
