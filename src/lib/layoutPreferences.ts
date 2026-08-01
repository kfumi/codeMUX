export const LAYOUT_PREFERENCES_STORAGE_KEY = 'codemux-layout-preferences';

export interface LayoutPreferences {
  windowWidth?: number;
  windowHeight?: number;
  sidebarRatio?: number;
  sidePanelRatio?: number;
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
      windowWidth: finitePositiveNumber(value.windowWidth),
      windowHeight: finitePositiveNumber(value.windowHeight),
      sidebarRatio: finitePositiveNumber(value.sidebarRatio),
      sidePanelRatio: finitePositiveNumber(value.sidePanelRatio),
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

