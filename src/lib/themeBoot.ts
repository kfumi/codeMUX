import type { Theme } from '../types/provider';

/**
 * 首帧前的主题引导(消除启动白闪)。
 *
 * ## 为什么需要它
 *
 * 主题的真值在 daemon 配置里(`AppConfig.theme`),渲染层要等 `fetchConfig()`
 * 拿到响应才知道深浅;而 `.dark` 只由 `applyThemeLocally()` 打到 `<html>` 上。
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
 * 两处若漂移(改了 key 却忘了改脚本,或反之),`themeBoot.test.ts` 里那条
 * 「index.html 必须逐字包含当前脚本」的断言会失败。
 *
 * ## 底色为什么也要跟着主题走
 *
 * 启动画面 `#boot`(index.html 内联样式)原本固定 `#111111`:深色主题下与壳的
 * `backgroundColor` 一致,浅色主题下就会「深底 → 浅底」跳一次,同源问题。
 * 这里给 `#boot` 喂一个 `--boot-bg` 自定义属性,由脚本按主题写入,浅色取
 * `#f2f2f2`(接近 `--sidebar-bg`),两边都不跳色。
 */

/** 渲染层写、内联脚本读的 localStorage key(存原始枚举,不是布尔)。 */
export const THEME_BOOT_STORAGE_KEY = 'codemux:theme';

/** 启动画面底色:深色对齐壳的 backgroundColor / globals.css 的 --background 量级。 */
export const BOOT_BACKGROUND_DARK = '#111111';
export const BOOT_BACKGROUND_LIGHT = '#f2f2f2';

/**
 * 首帧前的 `<html>` 底色。刻意与 globals.css 的 `--background` 同步
 * (亮色 `hsl(0 0% 100%)`、深色 `hsl(0 0% 9.4%)`),这样开发态 CSS 尚未注入的那
 * 一两帧、以及滚动回弹露出的 html 区域,底色都与应用一致 —— 用 `--boot-bg`
 * 那种「近似值」会让浅色主题的滚动回弹露出灰色。
 */
export const APP_BACKGROUND_DARK = 'hsl(0 0% 9.4%)';
export const APP_BACKGROUND_LIGHT = 'hsl(0 0% 100%)';

export function isTheme(value: unknown): value is Theme {
  return value === 'Dark' || value === 'Light' || value === 'System';
}

/** 缓存缺失/非法时按系统偏好兜底,与 `resolveIsDark()` 的语义保持一致。 */
export function resolveBootIsDark(theme: Theme | null, prefersDark: boolean): boolean {
  if (theme === 'Dark') return true;
  if (theme === 'Light') return false;
  return prefersDark;
}

export function bootBackground(isDark: boolean): string {
  return isDark ? BOOT_BACKGROUND_DARK : BOOT_BACKGROUND_LIGHT;
}

export function appBackground(isDark: boolean): string {
  return isDark ? APP_BACKGROUND_DARK : APP_BACKGROUND_LIGHT;
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
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
  root.style.backgroundColor = appBackground(isDark);
  root.style.setProperty('--boot-bg', bootBackground(isDark));
}

/**
 * 注入 index.html `<head>` 的**经典**内联脚本(不是 module):
 * module 会被 defer 到解析之后,那时首帧可能已经画完了,那就失去意义了。
 * 单行 IIFE 是刻意的 —— index.html 里逐字可复制,测试直接整串比对。
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var r=document.documentElement;var s=null;try{s=window.localStorage.getItem('${THEME_BOOT_STORAGE_KEY}')}catch(e){}var q=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var d=s==='Dark'?true:s==='Light'?false:q;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';r.style.backgroundColor=d?'${APP_BACKGROUND_DARK}':'${APP_BACKGROUND_LIGHT}';r.style.setProperty('--boot-bg',d?'${BOOT_BACKGROUND_DARK}':'${BOOT_BACKGROUND_LIGHT}')}catch(e){}})();`;
