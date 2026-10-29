/**
 * 首帧之前的主题落地（消除启动白闪）与运行期的 `<html>` chrome 同步。
 *
 * ## 为什么需要它
 *
 * 主题的真值在 daemon 配置里(`AppConfig.theme`),渲染层要等 `fetchConfig()`
 * 拿到响应才知道深浅;而 `.dark` 只由本模块的 `syncThemeChrome()` 打到 `<html>` 上。
 * 于是在「HTML 已解析、bundle 已挂载、配置还没回来」这段窗口里,界面是按
 * `:root` 的**亮色**变量绘制的,随后再整体翻成深色 —— 这就是首启看到的那一下白闪。
 * 这个窗口不是几毫秒:daemon 首次拉起 + 配置往返 + React 首帧,几百毫秒起步。
 *
 * `index.html` 里的内联脚本没法 import 本模块(它在任何模块之前执行),所以这段
 * 逻辑的**同一份源码**放在下面,渲染层与内联脚本共用:
 * - 写:`cacheBootTheme()` —— 每次应用主题时把原始枚举缓存进 localStorage;
 * - 读:内联脚本 `THEME_BOOT_SCRIPT` —— 在 `<head>` 解析期同步给 `<html>` 打上
 *   `.dark`,首帧就是对的。
 *
 * 两处若漂移(改了 key 却忘了改脚本,或反之),`boot.test.ts` 里那条
 * 「index.html 必须逐字包含当前脚本」的断言会失败。
 *
 * ## 底色为什么从种子取
 *
 * 首帧底色与运行期 `--background` 必须同源,否则滚动回弹会露出一帧异色。
 * `--background` 由 `deriveThemeTokens` 从 `surface` 种子派生,而脚本跑不了派生
 * 引擎,只能拿字面量 —— 所以这里**直接插值种子本身**,而不是另设一组
 * 「与种子同步」的常量。曾经有 `APP_BACKGROUND_*` / `BOOT_BACKGROUND_*` 四个
 * 常量逐位复制种子,靠注释提醒人别改错;现在它们全部删掉,只剩种子一个来源。
 */

import { CODEX_DARK_SEEDS, CODEX_LIGHT_SEEDS } from '../colorDerivation';
import type { Theme } from '../../types/provider';

/** 渲染层写、内联脚本读的 localStorage key(存原始枚举,不是布尔)。 */
export const THEME_BOOT_STORAGE_KEY = 'codemux:theme';

/** 首帧底色 = `surface` 种子,与 `deriveThemeTokens` 的 `--background` 同源。 */
export function surfaceFor(isDark: boolean): string {
  return isDark ? CODEX_DARK_SEEDS.surface : CODEX_LIGHT_SEEDS.surface;
}

export function isTheme(value: unknown): value is Theme {
  return value === 'Dark' || value === 'Light' || value === 'System';
}

export function readBootTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_BOOT_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function cacheBootTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, theme);
  } catch {
    // localStorage 不可用(隐私模式/配额)时,首帧退回系统偏好,不影响正确性。
  }
}

/**
 * 把主题相关的三个东西一次性对齐:`.dark` 类、`color-scheme`(原生控件/滚动条)、
 * `<html>` 底色与启动画面底色。
 *
 * 首帧由内联脚本做同一件事;这里在运行期每次切主题都重做一遍,免得
 * html 上留着上一次启动时的底色(切主题后滚动回弹会露出来)。
 */
export function syncThemeChrome(isDark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const surface = surfaceFor(isDark);
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
  root.style.backgroundColor = surface;
  root.style.setProperty('--boot-bg', surface);
}

/**
 * 注入 index.html `<head>` 的**经典**内联脚本(不是 module):
 * module 会被 defer 到解析之后,那时首帧可能已经画完了,那就失去意义了。
 * 单行 IIFE 是刻意的 —— index.html 里逐字可复制,测试直接整串比对。
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var r=document.documentElement;var s=null;try{s=window.localStorage.getItem('${THEME_BOOT_STORAGE_KEY}')}catch(e){}var q=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var d=s==='Dark'?true:s==='Light'?false:q;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';r.style.backgroundColor=d?'${CODEX_DARK_SEEDS.surface}':'${CODEX_LIGHT_SEEDS.surface}';r.style.setProperty('--boot-bg',d?'${CODEX_DARK_SEEDS.surface}':'${CODEX_LIGHT_SEEDS.surface}');var h=null;try{h=window.localStorage.getItem('codemux:host')}catch(e){}if(h==='desktop'||h==='browser'||h==='mobile'){r.dataset.host=h}}catch(e){}})();`;
