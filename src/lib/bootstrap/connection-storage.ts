/**
 * 浏览器形态的连接档案持久化(工单 02,用户故事 8)。
 *
 * 只存一份「当前配对档案」:desktopId / deviceId / Pairing Token / 连接列表。
 * 桌面壳形态不落这里 —— 壳注入 Local Daemon Token,不写浏览器存储。
 *
 * 读取一律经 [`normalizeStoredConnection`] 归一:早于档案结构的旧形状
 * (legacy baseUrl + token)会被迁移,避免升级后要求重新配对。
 */
import {
  normalizeStoredConnection,
  type CompanionConnectionProfile,
  type LegacyCompanionConnection,
} from '../companion-connection';

export const CONNECTION_STORAGE_KEY = 'codemux.companion.connection.v1';

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    // 隐私模式/被禁用的 localStorage:退化为「不持久化」而不是抛错。
    return null;
  }
}

export function loadStoredProfile(): CompanionConnectionProfile | null {
  const storage = safeStorage();
  if (!storage) return null;
  const raw = storage.getItem(CONNECTION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LegacyCompanionConnection | CompanionConnectionProfile;
    return normalizeStoredConnection(parsed);
  } catch {
    return null;
  }
}

export function saveStoredProfile(profile: CompanionConnectionProfile): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 配额/隐私模式失败:本次会话仍可用,只是下次需要重新配对。
  }
}

export function clearStoredProfile(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(CONNECTION_STORAGE_KEY);
  } catch {
    // ignore
  }
}
