// 桌面 UI 事件接缝(工单 09;工单 03 加了电脑控制活动载荷解析)的契约测试:
// 帧形状 → 事件名/载荷,以及活跃真值的取法(认不出就返回 null,不猜)。
import { describe, expect, it } from 'vitest';

import {
  COMPUTER_USE_ACTIVITY_EVENT,
  parseComputerUseActivity,
  parseDesktopUiEvent,
} from '../src/desktop-events';

function frame(event: unknown, sessionId = ''): string {
  return JSON.stringify({ type: 'event', sessionId, event });
}

describe('desktop-events 解析(工单 09/03)', () => {
  it('控制面事件帧 → {name, payload}', () => {
    expect(parseDesktopUiEvent(frame({ type: 'ui-event', name: 'sessions-changed', payload: { a: 1 } })))
      .toEqual({ name: 'sessions-changed', payload: { a: 1 } });
  });

  it('会话帧(非空 sessionId)、非事件帧、坏 JSON 一律忽略', () => {
    expect(parseDesktopUiEvent(frame({ type: 'ui-event', name: 'x', payload: null }, 'sess-1'))).toBeNull();
    expect(parseDesktopUiEvent(JSON.stringify({ type: 'hello', role: 'control' }))).toBeNull();
    expect(parseDesktopUiEvent('{ not json')).toBeNull();
  });

  it('电脑控制活动事件名固定,载荷 active 必须是布尔', () => {
    expect(COMPUTER_USE_ACTIVITY_EVENT).toBe('computer-use-activity');
    // daemon(工单 01)发的是 ActivitySnapshot 的 camelCase 序列化。
    expect(parseComputerUseActivity({ active: true, sessions: [] })).toBe(true);
    expect(parseComputerUseActivity({ active: false, sessions: [] })).toBe(false);
  });

  it('活动载荷认不出形状时返回 null(宁可不动武装状态,也不瞎撤)', () => {
    expect(parseComputerUseActivity(null)).toBeNull();
    expect(parseComputerUseActivity({})).toBeNull();
    expect(parseComputerUseActivity({ active: 'true' })).toBeNull();
    expect(parseComputerUseActivity({ sessions: [] })).toBeNull();
  });
});
