// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestWebNotificationPermission,
  resolveNotificationChannel,
  showWebNotification,
  webNotificationSupport,
} from './webNotifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveNotificationChannel', () => {
  it('keeps the shell notification path for the desktop host', () => {
    expect(resolveNotificationChannel(
      { systemNotifications: true, webNotifications: false },
      'granted',
    )).toBe('system');
  });

  it('falls back to web notifications only when the browser granted permission', () => {
    const presentation = { systemNotifications: false, webNotifications: true };
    expect(resolveNotificationChannel(presentation, 'granted')).toBe('web');
    expect(resolveNotificationChannel(presentation, 'default')).toBe('none');
    expect(resolveNotificationChannel(presentation, 'denied')).toBe('none');
    expect(resolveNotificationChannel(presentation, 'unsupported')).toBe('none');
  });

  it('stays silent in hosts without any notification capability', () => {
    expect(resolveNotificationChannel(
      { systemNotifications: false, webNotifications: false },
      'granted',
    )).toBe('none');
  });
});

describe('webNotificationSupport', () => {
  it('reports unsupported when the constructor is missing', () => {
    vi.stubGlobal('Notification', undefined);
    expect(webNotificationSupport()).toBe('unsupported');
  });

  it('reflects the current permission', () => {
    vi.stubGlobal('Notification', Object.assign(
      class { constructor() {} },
      { permission: 'granted' },
    ));
    expect(webNotificationSupport()).toBe('granted');
  });
});

describe('requestWebNotificationPermission', () => {
  it('returns the granted permission', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', Object.assign(class {}, {
      permission: 'default',
      requestPermission,
    }));

    await expect(requestWebNotificationPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('degrades to denied instead of throwing', async () => {
    vi.stubGlobal('Notification', Object.assign(class {}, {
      permission: 'default',
      requestPermission: vi.fn(async () => {
        throw new Error('blocked');
      }),
    }));
    await expect(requestWebNotificationPermission()).resolves.toBe('denied');
  });
});

describe('showWebNotification', () => {
  it('does not construct a notification without permission', () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'default' }));
    expect(showWebNotification({ title: 't', body: 'b', sessionId: 's1' })).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('tags notifications per session and routes clicks back', () => {
    const instances: Array<{ title: string; options?: NotificationOptions }> = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = vi.fn(async () => 'granted');
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(public title: string, public options?: NotificationOptions) {
        instances.push(this);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    // jsdom 未实现 window.focus,点击路径会打印噪音告警。
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

    const onClick = vi.fn();
    expect(showWebNotification(
      { title: '任务已完成', body: '重构设置页', sessionId: 'session-1' },
      { onClick },
    )).toBe(true);
    expect(instances[0].options?.tag).toBe('codemux:session-1');

    instances[0].onclick?.();
    expect(onClick).toHaveBeenCalledWith('session-1');
    focus.mockRestore();
  });

  it('swallows constructor failures', () => {
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      constructor() {
        throw new Error('denied by platform');
      }
    });
    expect(showWebNotification({ title: 't', body: 'b', sessionId: 's1' })).toBe(false);
  });
});
