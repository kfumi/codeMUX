// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { SHORTCUT_COMMANDS } from '../../lib/shortcuts/keyboardShortcuts';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';

const setKeybindingsMock = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

// 平台固定成 win32，测试才与运行机器无关：`Mod` 解析成 Ctrl，但键位字符串的
// 规范写法始终是 `Mod+...`（`Mod` 才是模型里的修饰键名）。
vi.mock('../../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32',
}));

const setKeybindingsFacadeMock = vi.hoisted(() => vi.fn());

// 只有集成用例走真实 store 动作；其余用例仍在 beforeEach 里替换成 mock。
vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: { setKeybindings: setKeybindingsFacadeMock },
}));

const realSetKeybindings = useSettingsStore.getState().setKeybindings;

function setKeybindingsConfig(keybindings: Record<string, string | null>) {
  useSettingsStore.setState({
    config: { keybindings } as unknown as AppConfig,
    setKeybindings: setKeybindingsMock,
  } as Partial<ReturnType<typeof useSettingsStore.getState>>);
}

/** 录制一行并按下一次组合键；`act` 等 async store 动作落地，避免 act 警告。 */
async function record(commandId: string, init: KeyboardEventInit) {
  // 录制监听挂在 effect 上：先让点击后的 effect 落地，再派发按键。
  fireEvent.click(screen.getByTestId(`shortcut-record-${commandId}`));
  await act(async () => {
    fireEvent.keyDown(window, init);
  });
}

describe('KeyboardShortcutsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setKeybindingsMock.mockResolvedValue(undefined);
    setKeybindingsConfig({});
  });

  afterEach(() => {
    cleanup();
  });

  it('按分组列出全部命令；没有覆盖时「恢复默认」禁用', () => {
    render(<KeyboardShortcutsSettings />);

    for (const label of ['导航', '布局', '会话']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const command of SHORTCUT_COMMANDS) {
      expect(screen.getByText(command.label)).toBeTruthy();
    }
    // 「恢复默认」常驻标题右侧，没有覆盖时禁用。
    expect((screen.getByTestId('shortcut-reset-all') as HTMLButtonElement).disabled).toBe(true);
    // 行尾的恢复图标同理：没改过的命令不能恢复，但始终可见。
    expect((screen.getByTestId('shortcut-reset-openSearch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('显式解绑的命令显示为「已禁用」而不是「未绑定」', () => {
    setKeybindingsConfig({ openSearch: null });
    render(<KeyboardShortcutsSettings />);

    expect(screen.getByTestId('shortcut-binding-openSearch').textContent).toBe('已禁用');
    expect(screen.getByTestId('shortcut-reset-openSearch')).toBeTruthy();
  });

  it('录制合法组合键写入规范化后的覆盖', async () => {
    render(<KeyboardShortcutsSettings />);

    await record('newSession', { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true });

    expect(setKeybindingsMock).toHaveBeenCalledTimes(1);
    // win32 上 Ctrl 就是 `Mod`；规范化顺序为 Mod+Ctrl+Alt+Shift。
    expect(setKeybindingsMock).toHaveBeenCalledWith({ newSession: 'Mod+Shift+K' });
    expect(toast.error).not.toHaveBeenCalled();
    // 录制结束后药丸回到键位展示（默认键位没被 mock 改写）。
    expect(screen.getByTestId('shortcut-record-newSession').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('shortcut-binding-newSession').textContent).toBe('Ctrl+N');
  });

  it('裸键（无修饰键）被拒绝且不写入', async () => {
    render(<KeyboardShortcutsSettings />);

    await record('newSession', { key: 'k', code: 'KeyK' });

    expect(toast.error).toHaveBeenCalledWith('至少需要一个修饰键，或使用 F1–F12');
    expect(setKeybindingsMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('shortcut-record-newSession').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('shortcut-binding-newSession').textContent).toBe('Ctrl+N');
  });

  it('保留键位（Ctrl+C）被拒绝且不写入', async () => {
    render(<KeyboardShortcutsSettings />);

    await record('newSession', { key: 'c', code: 'KeyC', ctrlKey: true });

    expect(toast.error).toHaveBeenCalledWith('这个键位被系统或编辑器占用，换一个');
    expect(setKeybindingsMock).not.toHaveBeenCalled();
  });

  it('与其它命令冲突的组合键被拒绝且不写入', async () => {
    render(<KeyboardShortcutsSettings />);

    // Mod+B 是「折叠/展开侧边栏」的出厂默认。
    await record('newSession', { key: 'b', code: 'KeyB', ctrlKey: true });

    expect(toast.error).toHaveBeenCalledWith('与「折叠/展开侧边栏」冲突');
    expect(setKeybindingsMock).not.toHaveBeenCalled();
  });

  it('禁用写入显式解绑 null', async () => {
    render(<KeyboardShortcutsSettings />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('shortcut-disable-openSearch'));
    });

    expect(setKeybindingsMock).toHaveBeenCalledWith({ openSearch: null });
  });

  it('恢复默认删掉该命令的覆盖', async () => {
    setKeybindingsConfig({ openSearch: 'Mod+Shift+K', toggleSidebar: null });
    render(<KeyboardShortcutsSettings />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('shortcut-reset-openSearch'));
    });

    expect(setKeybindingsMock).toHaveBeenCalledWith({ toggleSidebar: null });
  });

  it('「恢复默认」写入空覆盖表', async () => {
    setKeybindingsConfig({ openSearch: 'Mod+Shift+K' });
    render(<KeyboardShortcutsSettings />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('shortcut-reset-all'));
    });

    expect(setKeybindingsMock).toHaveBeenCalledWith({});
  });

  it('Escape 取消录制且不写入', async () => {
    render(<KeyboardShortcutsSettings />);

    await record('newSession', { key: 'Escape', code: 'Escape' });

    expect(setKeybindingsMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('shortcut-record-newSession').getAttribute('aria-pressed')).toBe('false');
  });

  it('保存失败时提示错误并回到可操作状态（store 已回滚）', async () => {
    setKeybindingsMock.mockRejectedValueOnce(new Error('daemon down'));
    render(<KeyboardShortcutsSettings />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('shortcut-disable-openSearch'));
    });

    expect(toast.error).toHaveBeenCalledWith('快捷键保存失败');
    expect(screen.getByText(/daemon down/)).toBeTruthy();
    expect((screen.getByTestId('shortcut-disable-openSearch') as HTMLButtonElement).disabled).toBe(false);
  });

  it('真实 store 保存失败时回滚乐观更新并提示用户', async () => {
    setKeybindingsFacadeMock.mockRejectedValueOnce(new Error('daemon down'));
    useSettingsStore.setState({
      config: { keybindings: { openSearch: 'Mod+Shift+K' } } as unknown as AppConfig,
      setKeybindings: realSetKeybindings,
      error: null,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);

    render(<KeyboardShortcutsSettings />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('shortcut-disable-openSearch'));
    });

    // 只有 store 真的把失败抛回来，这里的 catch + toast 才会触发。
    expect(toast.error).toHaveBeenCalledWith('快捷键保存失败');
    expect(useSettingsStore.getState().config?.keybindings).toEqual({ openSearch: 'Mod+Shift+K' });
    expect((screen.getByTestId('shortcut-disable-openSearch') as HTMLButtonElement).disabled).toBe(false);
  });
});
