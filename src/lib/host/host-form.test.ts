import { describe, expect, it } from 'vitest';

import { detectHostForm, isLoopbackOrigin, looksLikeMobileClient } from './host-form';

describe('host-form', () => {
  it('treats a present shell bridge as the desktop host regardless of size', () => {
    expect(detectHostForm({ hasShellBridge: true })).toBe('desktop');
    expect(
      detectHostForm({
        hasShellBridge: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        viewportWidth: 390,
        maxTouchPoints: 5,
      }),
    ).toBe('desktop');
  });

  it('classifies a desktop browser as browser', () => {
    expect(
      detectHostForm({
        hasShellBridge: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        viewportWidth: 1440,
        maxTouchPoints: 0,
      }),
    ).toBe('browser');
  });

  it('classifies phone and tablet browsers as mobile', () => {
    expect(
      detectHostForm({
        hasShellBridge: false,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
        viewportWidth: 390,
      }),
    ).toBe('mobile');

    // 桌面 UA 但触屏且窄(可折叠设备/触屏笔记本竖屏)同样按移动形态布局。
    expect(
      looksLikeMobileClient({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', viewportWidth: 600, maxTouchPoints: 10 }),
    ).toBe(true);
    expect(
      looksLikeMobileClient({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', viewportWidth: 600, maxTouchPoints: 0 }),
    ).toBe(false);
    expect(
      looksLikeMobileClient({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', viewportWidth: 1280, maxTouchPoints: 10 }),
    ).toBe(false);
  });

  it('recognizes loopback origins only', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:9240')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:1420')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:9240')).toBe(true);
    expect(isLoopbackOrigin('http://app.localhost:9240')).toBe(true);

    expect(isLoopbackOrigin('http://192.168.1.8:9240')).toBe(false);
    expect(isLoopbackOrigin('https://codemux.example.com')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
  });
});
