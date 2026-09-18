import { useEffect, useMemo, useRef } from 'react';

import {
  SHORTCUT_COMMANDS,
  keybindingMatchesEvent,
  resolveKeybinding,
  shouldIgnoreKeydown,
  type ShortcutCommandId,
} from '../lib/shortcuts/keyboardShortcuts';
import { getShortcutPlatform } from '../lib/shortcuts/shortcutPlatform';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * 全局快捷键分发器：整个应用只有这一个 `window` keydown 监听。
 *
 * 取舍见 [ADR 0013](../../docs/adr/0013-user-configurable-keyboard-shortcuts.md)：
 *
 * - 不做作用域引擎。可绑定键位必须带修饰键或为 F1–F12（录制时已由
 *   `isAllowedKeybinding` 拒绝其余按键），所以不需要「焦点在输入框里就禁用快捷键」
 *   这类守卫；在 composer 里按带修饰键的组合照常触发命令。
 * - 只挡两类按键：纯修饰键，以及输入法组字中的 keydown。后者对中文输入法是必须的。
 * - 命中即 `preventDefault`，并保证一次按键最多命中一条命令（目录顺序，先命中者胜）。
 * - 内置浏览器面板聚焦时收不到 keydown（焦点在网页里），因此那里的快捷键不生效。
 */
export function useKeyboardShortcuts(run: (id: ShortcutCommandId) => void) {
  const overrides = useSettingsStore((state) => state.config?.keybindings);
  const platform = useMemo(() => getShortcutPlatform(), []);
  // 执行体放在 ref 里：它每次渲染都是新函数，但重新订阅窗口监听没有意义
  const runRef = useRef(run);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreKeydown(event)) return;
      // 焦点所在的组件已经消费过这次按键（composer 的 Enter、终端的 Ctrl+B 等）
      // 就不再抢：监听在冒泡期，组件的处理器先跑，preventDefault 是它们「已处理」的信号。
      if (event.defaultPrevented) return;

      const command = SHORTCUT_COMMANDS.find((candidate) =>
        keybindingMatchesEvent(
          resolveKeybinding(candidate, overrides, platform),
          event,
          platform,
        ),
      );
      if (!command) return;

      // 按住不放时历史类命令会一路翻到底，按一次只走一步
      if (event.repeat && (command.id === 'navigateBack' || command.id === 'navigateForward')) {
        return;
      }

      event.preventDefault();
      runRef.current(command.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overrides, platform]);
}
