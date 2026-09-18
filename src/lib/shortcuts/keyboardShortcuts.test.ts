import { describe, expect, it } from 'vitest';

import {
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUP_ORDER,
  countKeybindingOverrides,
  defaultKeybinding,
  findKeybindingConflict,
  isAllowedKeybinding,
  isKeybindingCustomized,
  isKeybindingTaken,
  isReservedKeybinding,
  keybindingDisplayParts,
  keybindingFromEvent,
  keybindingMatchesEvent,
  keybindingsConflict,
  keybindingToAriaKeyshortcuts,
  normalizeKeybinding,
  resetKeybindingOverride,
  resolveKeybinding,
  shouldIgnoreKeydown,
  withKeybindingOverride,
  type KeyboardEventLike,
  type KeybindingOverrides,
  type ShortcutPlatform,
} from './keyboardShortcuts';
import { resolveShortcutPlatform } from './shortcutPlatform';

const MAC: ShortcutPlatform = 'darwin';
const WIN: ShortcutPlatform = 'win32';

function keyEvent(partial: Partial<KeyboardEventLike> & { key: string }): KeyboardEventLike {
  return { code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

function command(id: string) {
  const found = SHORTCUT_COMMANDS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing command ${id}`);
  return found;
}

describe('命令目录', () => {
  it('首版收录 9 条命令且 id 唯一', () => {
    expect(SHORTCUT_COMMANDS).toHaveLength(9);
    expect(new Set(SHORTCUT_COMMANDS.map((entry) => entry.id)).size).toBe(9);
  });

  it('分组都在已知分组内，且每条命令都有标签与说明', () => {
    for (const entry of SHORTCUT_COMMANDS) {
      expect(SHORTCUT_GROUP_ORDER).toContain(entry.group);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('三平台的出厂默认都合法、非保留、且互不冲突', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as ShortcutPlatform[]) {
      const bindings = SHORTCUT_COMMANDS.map((entry) => defaultKeybinding(entry, platform));
      for (const binding of bindings) {
        expect(isAllowedKeybinding(binding), `${binding} 必须带修饰键或为 F1–F12`).toBe(true);
        expect(isReservedKeybinding(binding, platform), `${binding} 命中保留键位`).toBe(false);
        expect(normalizeKeybinding(binding), `${binding} 规范化失败`).not.toBeNull();
      }
      const normalized = bindings.map((binding) => normalizeKeybinding(binding));
      expect(new Set(normalized).size, `${platform} 上存在重复默认键位`).toBe(bindings.length);
    }
  });
});

describe('normalizeKeybinding', () => {
  it('把修饰键重排成 Mod+Ctrl+Alt+Shift 的规范顺序', () => {
    expect(normalizeKeybinding('Shift+Mod+p')).toBe('Mod+Shift+P');
    expect(normalizeKeybinding('Alt+Ctrl+Shift+Mod+F5')).toBe('Mod+Ctrl+Alt+Shift+F5');
    // 修饰键名大小写不敏感（config.json 可被手改），但输出始终规范
    expect(normalizeKeybinding('ctrl+k')).toBe('Ctrl+K');
    expect(normalizeKeybinding('mod+period')).toBe('Mod+Period');
  });

  it('拒绝未知修饰键、未知按键与空值', () => {
    expect(normalizeKeybinding('Unknown+K')).toBeNull();
    expect(normalizeKeybinding('Mod+Escape')).toBeNull();
    expect(normalizeKeybinding('Mod+Nope')).toBeNull();
    expect(normalizeKeybinding('')).toBeNull();
    expect(normalizeKeybinding(null)).toBeNull();
    expect(normalizeKeybinding(42)).toBeNull();
  });
});

describe('resolveKeybinding', () => {
  it('没有覆盖时给出该平台的出厂默认', () => {
    expect(resolveKeybinding(command('openSearch'), undefined, WIN)).toBe('Mod+K');
    expect(resolveKeybinding(command('openSearch'), {}, MAC)).toBe('Mod+K');
  });

  it('自定义覆盖优先于出厂默认', () => {
    expect(resolveKeybinding(command('openSearch'), { openSearch: 'Mod+Shift+K' }, WIN)).toBe(
      'Mod+Shift+K',
    );
  });

  it('null 是显式解绑，不会被回落成出厂默认', () => {
    expect(resolveKeybinding(command('openSearch'), { openSearch: null }, WIN)).toBeNull();
  });

  it('非法的存储值等价于没有覆盖', () => {
    expect(resolveKeybinding(command('openSearch'), { openSearch: 'Mod+Escape' }, WIN)).toBe('Mod+K');
  });
});

describe('keybindingFromEvent', () => {
  it('Mod 在 macOS 取 metaKey、在 Windows 取 ctrlKey', () => {
    const onMac = keyEvent({ key: 'k', code: 'KeyK', metaKey: true });
    const onWin = keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(keybindingFromEvent(onMac, MAC)).toBe('Mod+K');
    expect(keybindingFromEvent(onWin, WIN)).toBe('Mod+K');
    expect(keybindingFromEvent(onMac, WIN)).toBe('K');
  });

  it('macOS 上物理 Ctrl 是独立的 Ctrl 修饰键', () => {
    const event = keyEvent({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true });
    expect(keybindingFromEvent(event, MAC)).toBe('Mod+Ctrl+F');
  });

  it('按 event.code 取物理键：不同布局下的同一个物理键得出同一结果', () => {
    // 中文/德文布局下 `[` 键的 key 可能是别的字符，code 仍是 BracketLeft
    expect(keybindingFromEvent(keyEvent({ key: 'ü', code: 'BracketLeft', ctrlKey: true }), WIN)).toBe(
      'Mod+BracketLeft',
    );
    expect(keybindingFromEvent(keyEvent({ key: '.', code: 'Period', ctrlKey: true }), WIN)).toBe(
      'Mod+Period',
    );
    expect(keybindingFromEvent(keyEvent({ key: '3', code: 'Digit3', ctrlKey: true }), WIN)).toBe(
      'Mod+3',
    );
    expect(keybindingFromEvent(keyEvent({ key: 'F11', code: 'F11' }), WIN)).toBe('F11');
  });

  it('没有 code 时回落到 key，且拒绝不可绑定的按键', () => {
    expect(keybindingFromEvent(keyEvent({ key: ',', ctrlKey: true }), WIN)).toBe('Mod+Comma');
    expect(keybindingFromEvent(keyEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), WIN)).toBeNull();
    expect(keybindingFromEvent(keyEvent({ key: 'Escape', code: 'Escape' }), WIN)).toBeNull();
  });
});

describe('keybindingMatchesEvent', () => {
  it('命中与不命中', () => {
    const event = keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(keybindingMatchesEvent('Mod+K', event, WIN)).toBe(true);
    expect(keybindingMatchesEvent('Mod+Shift+K', event, WIN)).toBe(false);
    // 解绑的键位永不命中
    expect(keybindingMatchesEvent(null, event, WIN)).toBe(false);
  });

  it('未加 Shift 的 Equal 绑定仍能命中物理 Equal 键产出的 +', () => {
    const event = keyEvent({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
    expect(keybindingMatchesEvent('Mod+Equal', event, WIN)).toBe(true);
  });
});

describe('shouldIgnoreKeydown', () => {
  it('忽略只按下修饰键的 keydown', () => {
    expect(shouldIgnoreKeydown(keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBe(true);
    expect(shouldIgnoreKeydown(keyEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBe(true);
  });

  it('忽略输入法组字中的 keydown（含 229）', () => {
    expect(shouldIgnoreKeydown(keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }))).toBe(true);
    expect(shouldIgnoreKeydown(keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true, keyCode: 229 }))).toBe(true);
  });

  it('普通带修饰键的按键不被忽略', () => {
    expect(shouldIgnoreKeydown(keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true, keyCode: 75 }))).toBe(false);
  });
});

describe('可绑定性与保留键位', () => {
  it('必须带修饰键，或为 F1–F12', () => {
    expect(isAllowedKeybinding('Mod+K')).toBe(true);
    expect(isAllowedKeybinding('Alt+Space')).toBe(true);
    expect(isAllowedKeybinding('F5')).toBe(true);
    expect(isAllowedKeybinding('A')).toBe(false);
    expect(isAllowedKeybinding('Space')).toBe(false);
    expect(isAllowedKeybinding('F13')).toBe(false);
  });

  it('保留键位按平台区分', () => {
    expect(isReservedKeybinding('Mod+C', WIN)).toBe(true);
    expect(isReservedKeybinding('Mod+Enter', MAC)).toBe(true);
    expect(isReservedKeybinding('Mod+W', MAC)).toBe(true);
    expect(isReservedKeybinding('Mod+W', WIN)).toBe(false);
    expect(isReservedKeybinding('Alt+F4', WIN)).toBe(true);
    expect(isReservedKeybinding('Alt+F4', MAC)).toBe(false);
    expect(isReservedKeybinding('Mod+K', WIN)).toBe(false);
  });
});

describe('冲突判定', () => {
  it('同样的规范化键位冲突，Equal 与 Shift+Equal 也冲突', () => {
    expect(keybindingsConflict('Mod+K', 'Mod+K')).toBe(true);
    expect(keybindingsConflict('shift+mod+k', 'Mod+Shift+K')).toBe(true);
    expect(keybindingsConflict('Mod+Equal', 'Mod+Shift+Equal')).toBe(true);
    expect(keybindingsConflict('Mod+K', 'Mod+J')).toBe(false);
    expect(keybindingsConflict(null, 'Mod+K')).toBe(false);
  });

  it('findKeybindingConflict 只报其它命令的冲突', () => {
    expect(findKeybindingConflict(command('openSearch'), 'Mod+N', undefined, WIN)?.id).toBe('newSession');
    expect(findKeybindingConflict(command('openSearch'), 'Mod+Shift+K', undefined, WIN)).toBeNull();
    // 自己当前的键位不算冲突
    expect(findKeybindingConflict(command('openSearch'), 'Mod+K', undefined, WIN)).toBeNull();
  });

  it('被显式解绑的键位不再占用', () => {
    const overrides: KeybindingOverrides = { newSession: null };
    expect(findKeybindingConflict(command('openSearch'), 'Mod+N', overrides, WIN)).toBeNull();
    expect(isKeybindingTaken('Mod+N', overrides, WIN)).toBe(false);
    expect(isKeybindingTaken('Mod+N', undefined, WIN)).toBe(true);
    expect(isKeybindingTaken('Mod+Shift+K', undefined, WIN)).toBe(false);
  });
});

describe('键位展示', () => {
  it('macOS 用符号，其余平台用文字', () => {
    expect(keybindingDisplayParts('Mod+Shift+P', MAC)).toEqual(['⌘', '⇧', 'P']);
    expect(keybindingDisplayParts('Mod+Shift+P', WIN)).toEqual(['Ctrl', 'Shift', 'P']);
  });

  it('标点与方向键映射成可读文案', () => {
    expect(keybindingDisplayParts('Mod+BracketLeft', WIN)).toEqual(['Ctrl', '[']);
    expect(keybindingDisplayParts('Mod+Comma', MAC)).toEqual(['⌘', ',']);
    expect(keybindingDisplayParts('Mod+ArrowDown', WIN)).toEqual(['Ctrl', '↓']);
    expect(keybindingDisplayParts(null, WIN)).toEqual([]);
  });

  it('aria-keyshortcuts 用 ARIA 键名，解绑时不输出', () => {
    expect(keybindingToAriaKeyshortcuts('Mod+Shift+K', WIN)).toBe('Control+Shift+K');
    expect(keybindingToAriaKeyshortcuts('Mod+Shift+K', MAC)).toBe('Meta+Shift+K');
    expect(keybindingToAriaKeyshortcuts('Mod+BracketLeft', WIN)).toBe('Control+[');
    expect(keybindingToAriaKeyshortcuts('Alt+ArrowDown', WIN)).toBe('Alt+ArrowDown');
    expect(keybindingToAriaKeyshortcuts(null, WIN)).toBeNull();
  });
});

describe('覆盖的写入与重置', () => {
  it('写入自定义键位时规范化', () => {
    expect(withKeybindingOverride(undefined, command('openSearch'), 'shift+mod+k', WIN)).toEqual({
      openSearch: 'Mod+Shift+K',
    });
  });

  it('写入等于出厂默认的键位时丢弃该覆盖（不携带意图）', () => {
    const overrides: KeybindingOverrides = { openSearch: 'Mod+Shift+K' };
    expect(withKeybindingOverride(overrides, command('openSearch'), 'Mod+K', WIN)).toEqual({});
  });

  it('写入 null 表示显式解绑', () => {
    expect(withKeybindingOverride(undefined, command('openSearch'), null, WIN)).toEqual({
      openSearch: null,
    });
  });

  it('非法键位不改动现状', () => {
    const overrides: KeybindingOverrides = { openSearch: 'Mod+Shift+K' };
    expect(withKeybindingOverride(overrides, command('openSearch'), 'Mod+Escape', WIN)).toEqual(overrides);
  });

  it('重置与解绑是两件不同的事', () => {
    const overrides: KeybindingOverrides = { openSearch: null, newSession: 'Mod+Alt+N' };
    expect(resetKeybindingOverride(overrides, 'openSearch')).toEqual({ newSession: 'Mod+Alt+N' });
    expect(resolveKeybinding(command('openSearch'), resetKeybindingOverride(overrides, 'openSearch'), WIN)).toBe('Mod+K');
  });

  it('自定义判定与计数只认「有覆盖」', () => {
    expect(isKeybindingCustomized(command('openSearch'), undefined)).toBe(false);
    expect(isKeybindingCustomized(command('openSearch'), { openSearch: null })).toBe(true);
    expect(countKeybindingOverrides({ openSearch: null, newSession: 'Mod+Alt+N' })).toBe(2);
    expect(countKeybindingOverrides(undefined)).toBe(0);
  });
});

describe('平台判定', () => {
  it('识别 macOS、Windows 与其余平台', () => {
    expect(resolveShortcutPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('darwin');
    expect(resolveShortcutPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win32');
    expect(resolveShortcutPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(resolveShortcutPlatform('', 'MacIntel')).toBe('darwin');
  });
});
