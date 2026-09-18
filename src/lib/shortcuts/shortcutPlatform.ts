/**
 * 渲染层的平台真值源：`Mod` 解析成 Cmd 还是 Ctrl、键帽展示成 ⌘ 还是 Ctrl，
 * 都只看这一个函数。
 *
 * 此前仓库里只有 `AboutSettings` 里零散的 `userAgent.includes(...)` 判断；
 * 浏览器宿主没有壳桥可问，所以 userAgent 是唯一可用信号。
 */
import type { ShortcutPlatform } from './keyboardShortcuts';

/** 纯函数部分，便于测试。 */
export function resolveShortcutPlatform(userAgent: string, platform?: string): ShortcutPlatform {
  const signal = `${userAgent} ${platform ?? ''}`;
  // iPadOS 的桌面模式会把自己报成 Macintosh，这里一并归入 darwin：移动端没有物理
  // 键盘，落到哪个分支都不影响可用性，只影响键帽文案。
  if (/Mac OS X|Macintosh|MacIntel/i.test(signal)) return 'darwin';
  if (/Windows|Win32|Win64/i.test(signal)) return 'win32';
  return 'linux';
}

export function getShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  return resolveShortcutPlatform(navigator.userAgent, navigator.platform);
}
