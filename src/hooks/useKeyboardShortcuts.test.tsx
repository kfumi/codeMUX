// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShortcutCommandId } from '../lib/shortcuts/keyboardShortcuts';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppConfig } from '../types/provider';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

// 平台判定在真实环境里随机器而变（macOS 的 Mod 是 Cmd），这里钉死成 win32
// 让断言稳定；Mod 的平台映射本身由 keyboardShortcuts.test.ts 覆盖。
vi.mock('../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32' as const,
  resolveShortcutPlatform: () => 'win32' as const,
}));

type KeydownInit = KeyboardEventInit & { keyCode?: number; isComposing?: boolean };

function press(init: KeydownInit): KeyboardEvent {
  const { keyCode, isComposing, ...rest } = init;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest });
  if (keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: keyCode, configurable: true });
  }
  if (isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: isComposing, configurable: true });
  }
  window.dispatchEvent(event);
  return event;
}

function setKeybindings(keybindings: Record<string, string | null> | undefined) {
  useSettingsStore.setState({
    config: (keybindings === undefined ? null : { keybindings }) as unknown as AppConfig,
  });
}

describe('useKeyboardShortcuts', () => {
  let run: (id: ShortcutCommandId) => void;
  let runMock: ReturnType<typeof vi.fn>;

  function mount() {
    renderHook(() => useKeyboardShortcuts(run));
  }

  beforeEach(() => {
    setKeybindings(undefined);
    runMock = vi.fn();
    run = runMock as unknown as (id: ShortcutCommandId) => void;
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ config: null });
  });

  it('命中出厂默认键位时阻止默认行为并派发命令', () => {
    mount();
    const event = press({ key: 'k', code: 'KeyK', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(runMock).toHaveBeenCalledWith('openSearch');
  });

  it('未命中的按键不拦截，也不派发', () => {
    mount();
    const event = press({ key: '9', code: 'Digit9', ctrlKey: true, altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('只按下修饰键的 keydown 被忽略', () => {
    mount();
    press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('输入法组字中的 keydown 被忽略（中文输入法选词不误触发）', () => {
    mount();
    press({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true });
    press({ key: 'k', code: 'KeyK', ctrlKey: true, keyCode: 229 });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('按住不放时历史类命令只走一步', () => {
    mount();
    press({ key: '[', code: 'BracketLeft', ctrlKey: true, repeat: true });
    expect(runMock).not.toHaveBeenCalled();

    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith('navigateBack');
  });

  it('显式解绑后该键位不再触发，其它命令不受影响', () => {
    setKeybindings({ openSearch: null });
    mount();

    press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(runMock).not.toHaveBeenCalled();

    press({ key: 'n', code: 'KeyN', ctrlKey: true });
    expect(runMock).toHaveBeenCalledWith('newSession');
  });

  it('自定义覆盖生效且顶掉出厂默认', () => {
    setKeybindings({ openSearch: 'Mod+Shift+K' });
    mount();

    press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(runMock).not.toHaveBeenCalled();

    press({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(runMock).toHaveBeenCalledWith('openSearch');
  });

  it('物理键匹配：键盘布局改了 key 也照样命中', () => {
    mount();
    // 中文/德文布局下这个物理键的 key 不是 '[' 或 ']'
    press({ key: 'ü', code: 'BracketLeft', ctrlKey: true });

    expect(runMock).toHaveBeenCalledWith('navigateBack');
  });

  it('焦点组件已经消费过这次按键时不再抢（composer 的 Enter、终端的 Ctrl+B）', () => {
    mount();
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(runMock).not.toHaveBeenCalled();
  });

  it('卸载后不再监听', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts(run));
    unmount();

    press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(runMock).not.toHaveBeenCalled();
  });
});
