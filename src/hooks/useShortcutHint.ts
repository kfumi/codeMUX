import { useMemo } from 'react';

import {
  findShortcutCommand,
  keybindingDisplayParts,
  keybindingToAriaKeyshortcuts,
  resolveKeybinding,
  type ShortcutCommandId,
} from '../lib/shortcuts/keyboardShortcuts';
import { getShortcutPlatform } from '../lib/shortcuts/shortcutPlatform';
import { useSettingsStore } from '../stores/settingsStore';

function useShortcutBinding(id: ShortcutCommandId) {
  const overrides = useSettingsStore((state) => state.config?.keybindings);
  const platform = useMemo(() => getShortcutPlatform(), []);
  return {
    platform,
    binding: resolveKeybinding(findShortcutCommand(id), overrides, platform),
  };
}

/**
 * 某条命令当前生效键位的展示文案（如 `Ctrl+B`、macOS 上是 `⌘B`），
 * 供按钮的 tooltip 使用 —— 键位必须能被发现（ADR 0013）。
 *
 * 命令被显式解绑时返回 `null`，调用方据此不显示提示。
 */
export function useShortcutHint(id: ShortcutCommandId): string | null {
  const { binding, platform } = useShortcutBinding(id);
  const parts = keybindingDisplayParts(binding, platform);
  return parts.length > 0 ? parts.join(platform === 'darwin' ? '' : '+') : null;
}

/** 同一键位的 `aria-keyshortcuts` 写法（ARIA 的键名与展示文案不同）。 */
export function useShortcutAriaKeyshortcuts(id: ShortcutCommandId): string | null {
  const { binding, platform } = useShortcutBinding(id);
  return keybindingToAriaKeyshortcuts(binding, platform);
}
