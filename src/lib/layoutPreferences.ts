export const LAYOUT_PREFERENCES_STORAGE_KEY = 'codemux-layout-preferences';

export interface LayoutPreferences {
  /** 侧栏绝对宽度（px）；窗口最大化/还原时不随之缩放 */
  sidebarWidth?: number;
  sidebarRatio?: number;
  sidePanelRatio?: number;
  /** 底部终端面板高度（px）；只在用户拖过之后才有值。 */
  terminalDockHeight?: number;
  /** 底部终端面板上次是否展开；启动时据此恢复。 */
  terminalDockOpen?: boolean;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readLayoutPreferences(storage: Storage | null = getStorage()): LayoutPreferences {
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(LAYOUT_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const value = parsed as Record<string, unknown>;
    return {
      sidebarWidth: finitePositiveNumber(value.sidebarWidth),
      sidebarRatio: finitePositiveNumber(value.sidebarRatio),
      sidePanelRatio: finitePositiveNumber(value.sidePanelRatio),
      terminalDockHeight: finitePositiveNumber(value.terminalDockHeight),
      terminalDockOpen: booleanValue(value.terminalDockOpen),
    };
  } catch {
    return {};
  }
}

export function updateLayoutPreferences(
  patch: Partial<LayoutPreferences>,
  storage: Storage | null = getStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    const next = { ...readLayoutPreferences(storage), ...patch };
    storage.setItem(LAYOUT_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is optional and can be unavailable in private or restricted webviews.
  }
}
