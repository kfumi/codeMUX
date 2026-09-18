/**
 * 键盘快捷键的纯模型：命令目录、键位字符串的规范化与匹配、冲突与保留键位判定。
 *
 * 这里没有任何 React 或 store 依赖 —— 分发器（`src/hooks/useKeyboardShortcuts.ts`）、
 * 设置页与搜索对话框共用同一份判定。决策与取舍见
 * [ADR 0013](../../../docs/adr/0013-user-configurable-keyboard-shortcuts.md)：
 *
 * - 键位是字符串（`Mod+Shift+P`），`Mod` 表示 macOS 的 Cmd 与其余平台的 Ctrl；
 * - 键位按**物理键**（`event.code`）匹配，与键盘布局无关；
 * - 键位覆盖是三态：无覆盖（用出厂默认）、自定义、显式解绑（`null`）；
 * - 可绑定键位必须带至少一个修饰键或为 F1–F12，因此分发器不需要「焦点在输入框内
 *   就禁用快捷键」这类守卫。
 */

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux';

/** 命令分组只影响设置页的呈现顺序，不参与匹配。 */
export type ShortcutGroup = 'navigation' | 'layout' | 'agent';

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = ['navigation', 'layout', 'agent'];

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  navigation: '导航',
  layout: '布局',
  agent: '会话',
};

export const SHORTCUT_COMMAND_IDS = [
  'navigateBack',
  'navigateForward',
  'newSession',
  'openSettings',
  'openSearch',
  'toggleSidebar',
  'toggleSidePanel',
  'abort',
  'focusComposer',
] as const;

export type ShortcutCommandId = (typeof SHORTCUT_COMMAND_IDS)[number];

export type ShortcutCommand = {
  id: ShortcutCommandId;
  group: ShortcutGroup;
  /** 设置页与搜索结果里展示的中文名；没有 i18n 层，标签直接写在这里。 */
  label: string;
  /** 一句话说明，仅设置页使用。 */
  description: string;
  defaultBinding: string;
  /** macOS 专用出厂默认；缺省表示三平台同键位。 */
  macDefaultBinding?: string;
};

/**
 * 命令目录：应用内置的唯一真值源。用户只改键位，不改目录。
 * 顺序即匹配顺序，先命中者胜。
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  {
    id: 'navigateBack',
    group: 'navigation',
    label: '后退',
    description: '回到上一个界面',
    defaultBinding: 'Mod+BracketLeft',
  },
  {
    id: 'navigateForward',
    group: 'navigation',
    label: '前进',
    description: '前往下一个界面',
    defaultBinding: 'Mod+BracketRight',
  },
  {
    id: 'newSession',
    group: 'navigation',
    label: '新建会话',
    description: '在默认项目中新建一条草稿会话',
    defaultBinding: 'Mod+N',
  },
  {
    id: 'openSettings',
    group: 'navigation',
    label: '打开设置',
    description: '打开设置界面',
    defaultBinding: 'Mod+Comma',
  },
  {
    id: 'openSearch',
    group: 'navigation',
    label: '搜索会话与命令',
    description: '打开搜索，可跳转会话或运行命令',
    defaultBinding: 'Mod+K',
  },
  {
    id: 'toggleSidebar',
    group: 'layout',
    label: '折叠/展开侧边栏',
    description: '收起或展开会话列表',
    defaultBinding: 'Mod+B',
  },
  {
    id: 'toggleSidePanel',
    group: 'layout',
    label: '折叠/展开侧面板',
    description: '打开或收起右侧面板',
    defaultBinding: 'Mod+J',
  },
  {
    id: 'abort',
    group: 'agent',
    label: '停止生成',
    description: '中断当前会话正在进行的这一轮',
    defaultBinding: 'Mod+Period',
  },
  {
    id: 'focusComposer',
    group: 'agent',
    label: '聚焦输入框',
    description: '把光标移到消息输入框',
    defaultBinding: 'Mod+L',
  },
];

/**
 * 键位覆盖：`null` 是显式解绑（用户不要这个快捷键），缺键是「用出厂默认」。
 * 取值等于出厂默认的覆盖不携带用户意图，写入时由 `withKeybindingOverride` 丢弃。
 */
export type KeybindingOverrides = Partial<Record<ShortcutCommandId, string | null>>;

/**
 * 存储里可能出现的形态：它故意宽于 `KeybindingOverrides`，因为落盘的键位表可能
 * 仍在命名未来被改名的命令 id，读取时不能让整张表失效。
 */
export type PersistedKeybindingOverrides = Record<string, string | null | undefined>;

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/**
 * 可用作键位主键的具名键（DOM `KeyboardEvent.code` 拼写）。
 * 注意 `Escape` 故意不在其中：它在 composer 里有既有语义（取消当前轮与弹层），
 * 不对外开放绑定。
 */
const NAMED_KEYS = new Set<string>([
  'Enter',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Comma',
  'Period',
  'Equal',
  'Minus',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Backquote',
]);

/** 只按下修饰键本身时不该被当成一次按键（判定在 `shouldIgnoreKeydown`）。 */
const MODIFIER_ONLY_KEYS = new Set<string>([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Dead',
  'Unidentified',
]);

const MODIFIER_CODE_VALUES = /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/;

export type KeyboardEventLike = {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export function defaultKeybinding(
  command: ShortcutCommand,
  platform: ShortcutPlatform,
): string {
  return platform === 'darwin' && command.macDefaultBinding
    ? command.macDefaultBinding
    : command.defaultBinding;
}

/** 规范化键位字符串；未知修饰键或未知按键返回 `null`。 */
export function normalizeKeybinding(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('+').filter(Boolean);
  if (parts.length === 0) return null;
  const key = normalizeKey(parts[parts.length - 1] ?? '');
  if (!key) return null;
  // 修饰键名大小写不敏感：`config.json` 是用户可见、可能被手改的文件，
  // 容忍 `ctrl+k` 这类写法只放宽输入，输出始终是规范顺序的规范大小写。
  const modifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const canonical = MODIFIER_ORDER.find((name) => name.toLowerCase() === part.toLowerCase());
    if (!canonical) return null;
    modifiers.add(canonical);
  }
  return [...MODIFIER_ORDER.filter((part) => modifiers.has(part)), key].join('+');
}

/**
 * 某条命令当前生效的键位：自定义覆盖优先，`null` 表示显式解绑，
 * 其余回落出厂默认。非法覆盖值会被忽略（等价于没有覆盖）。
 */
export function resolveKeybinding(
  command: ShortcutCommand,
  overrides: KeybindingOverrides | PersistedKeybindingOverrides | undefined,
  platform: ShortcutPlatform,
): string | null {
  const stored = overrides ? overrides[command.id] : undefined;
  if (stored === null) return null;
  return normalizeKeybinding(stored) ?? defaultKeybinding(command, platform);
}

export function keybindingFromEvent(
  event: KeyboardEventLike,
  platform: ShortcutPlatform,
): string | null {
  const key = keyFromEvent(event);
  if (!key) return null;
  const modifiers: string[] = [];
  if (platform === 'darwin' ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
  if (platform === 'darwin' && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return normalizeKeybinding([...modifiers, key].join('+'));
}

export function keybindingMatchesEvent(
  binding: string | null | undefined,
  event: KeyboardEventLike,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeKeybinding(binding);
  const fromEvent = keybindingFromEvent(event, platform);
  if (!normalized || !fromEvent) return false;
  if (normalized === fromEvent) return true;
  // 物理 Equal 键在按下 Shift 时产出 `+` 而不是 `=`；未加 Shift 的绑定
  // （如缩放）应当照常命中。
  return shiftedEqualVariant(normalized) === fromEvent;
}

export function keybindingsConflict(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeKeybinding(left);
  const normalizedRight = normalizeKeybinding(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return (
    shiftedEqualVariant(normalizedLeft) === normalizedRight ||
    shiftedEqualVariant(normalizedRight) === normalizedLeft
  );
}

/** 可绑定性的唯一硬约束：必须带修饰键，或为 F1–F12。 */
export function isAllowedKeybinding(binding: string): boolean {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts[parts.length - 1] ?? '';
  return parts.length > 1 || /^F(?:[1-9]|1[0-2])$/.test(key);
}

/** 属于宿主平台或文本编辑语义、不允许被任何 Shortcut 占用的键位。 */
export function isReservedKeybinding(binding: string, platform: ShortcutPlatform): boolean {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return false;
  const reserved = new Set<string>([
    'Mod+A',
    'Mod+C',
    'Mod+V',
    'Mod+X',
    'Mod+Z',
    'Mod+Shift+Z',
    'Mod+R',
    'Mod+Enter',
  ]);
  if (platform === 'darwin') {
    reserved.add('Mod+Q');
    reserved.add('Mod+H');
    // macOS 把 Cmd+W 用在它自己的关窗命令上，应用内快捷键不得占用。
    reserved.add('Mod+W');
  } else {
    reserved.add('Mod+Y');
    reserved.add('Alt+F4');
  }
  return reserved.has(normalized);
}

/** 渲染成展示用的键帽文案（macOS 用 ⌘⌃⌥⇧，其余平台用 Ctrl/Alt/Shift）。 */
export function keybindingDisplayParts(
  binding: string | null | undefined,
  platform: ShortcutPlatform,
): string[] {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return [];
  const modifiers: Record<string, string> =
    platform === 'darwin'
      ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
      : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return normalized
    .split('+')
    .map((part) => modifiers[part] ?? DISPLAY_KEY_NAMES[part] ?? part);
}

/**
 * `aria-keyshortcuts` 用的键位写法（`Control+B`、`Meta+Shift+K`）。
 * 与展示文案不同：这里必须是 ARIA 规范里的键名，标点写成字符本身，
 * 方向键保持 `ArrowUp` 这类名字。解绑时返回 `null`（调用方不写该属性）。
 */
export function keybindingToAriaKeyshortcuts(
  binding: string | null | undefined,
  platform: ShortcutPlatform,
): string | null {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return null;
  return normalized
    .split('+')
    .map((part) => {
      if (part === 'Mod') return platform === 'darwin' ? 'Meta' : 'Control';
      if (part === 'Ctrl') return 'Control';
      if (part === 'Alt') return 'Alt';
      if (part === 'Shift') return 'Shift';
      return ARIA_KEY_NAMES[part] ?? part;
    })
    .join('+');
}

/** 只按下了修饰键，或正处于输入法组字中：都不该被当成一次快捷键按键。 */
export function shouldIgnoreKeydown(event: KeyboardEventLike): boolean {
  if (MODIFIER_ONLY_KEYS.has(event.key)) return true;
  if (MODIFIER_CODE_VALUES.test(event.code ?? '')) return true;
  // 输入法组字期间的 keydown（含 Safari/旧版 Chromium 的 229）不参与匹配，
  // 否则中文输入法选词会误触发命令。
  return event.isComposing === true || event.keyCode === 229;
}

/** 该命令是否有覆盖（包括显式解绑）。等于出厂默认的覆盖在写入时就被丢弃了。 */
export function isKeybindingCustomized(
  command: ShortcutCommand,
  overrides: KeybindingOverrides | PersistedKeybindingOverrides | undefined,
): boolean {
  return !!overrides && Object.prototype.hasOwnProperty.call(overrides, command.id);
}

export function countKeybindingOverrides(
  overrides: KeybindingOverrides | PersistedKeybindingOverrides | undefined,
): number {
  return overrides ? Object.keys(overrides).length : 0;
}

/**
 * 写入一条覆盖。`binding` 为 `null` 表示显式解绑；取值等于出厂默认时删除该键，
 * 因为「等于默认」不携带用户意图。非法键位不改动现状。
 */
export function withKeybindingOverride(
  overrides: KeybindingOverrides | undefined,
  command: ShortcutCommand,
  binding: string | null,
  platform: ShortcutPlatform,
): KeybindingOverrides {
  const next: KeybindingOverrides = { ...(overrides ?? {}) };
  if (binding === null) {
    next[command.id] = null;
    return next;
  }
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return overrides ?? {};
  if (normalized === normalizeKeybinding(defaultKeybinding(command, platform))) {
    delete next[command.id];
    return next;
  }
  next[command.id] = normalized;
  return next;
}

/** 恢复出厂默认：删除覆盖（与「显式解绑」不同）。 */
export function resetKeybindingOverride(
  overrides: KeybindingOverrides | undefined,
  commandId: ShortcutCommandId,
): KeybindingOverrides {
  const next: KeybindingOverrides = { ...(overrides ?? {}) };
  delete next[commandId];
  return next;
}

/** 找出该键位与哪条**其他**命令冲突；没有冲突返回 `null`。 */
export function findKeybindingConflict(
  command: ShortcutCommand,
  binding: string,
  overrides: KeybindingOverrides | PersistedKeybindingOverrides | undefined,
  platform: ShortcutPlatform,
): ShortcutCommand | null {
  return (
    SHORTCUT_COMMANDS.find(
      (candidate) =>
        candidate.id !== command.id &&
        keybindingsConflict(resolveKeybinding(candidate, overrides, platform), binding),
    ) ?? null
  );
}

/** 该键位是否已经被其它命令占用（`null`/空被解绑的键位永不冲突）。 */
export function isKeybindingTaken(
  binding: string,
  overrides: KeybindingOverrides | PersistedKeybindingOverrides | undefined,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeKeybinding(binding);
  if (!normalized) return false;
  return SHORTCUT_COMMANDS.some((command) =>
    keybindingsConflict(resolveKeybinding(command, overrides, platform), normalized),
  );
}

export function findShortcutCommand(id: ShortcutCommandId): ShortcutCommand {
  const command = SHORTCUT_COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Unknown shortcut command: ${id}`);
  return command;
}

function shiftedEqualVariant(binding: string): string | null {
  return binding.endsWith('+Equal') && !binding.includes('+Shift+')
    ? binding.replace('+Equal', '+Shift+Equal')
    : null;
}

function normalizeKey(value: string): string | null {
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
  return NAMED_KEY_LOOKUP.get(value.toLowerCase()) ?? null;
}

/** `period` → `Period`：具名键同样大小写不敏感。 */
const NAMED_KEY_LOOKUP = new Map<string, string>(
  [...NAMED_KEYS].map((name) => [name.toLowerCase(), name]),
);

/**
 * 按键 → 键位主键。一律取 `event.code`（物理键）：与键盘布局无关，
 * 且 Option+I 这类会产出死键的字符不受影响。
 */
function keyFromEvent(event: KeyboardEventLike): string | null {
  const code = event.code ?? '';
  if (MODIFIER_ONLY_KEYS.has(event.key) || MODIFIER_CODE_VALUES.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (NAMED_KEYS.has(code)) return code;

  const aliases: Record<string, string> = {
    ' ': 'Space',
    ',': 'Comma',
    '.': 'Period',
    '=': 'Equal',
    '+': 'Equal',
    '-': 'Minus',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '`': 'Backquote',
  };
  return normalizeKey(aliases[event.key] ?? event.key);
}

const DISPLAY_KEY_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** ARIA 键名与内部具名键不同的那几个（方向键、Enter 等在 ARIA 里同名，直接透传）。 */
const ARIA_KEY_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: ' ',
};
