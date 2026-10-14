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
 * 这里给 `#boot` 喂一个 `--boot-bg` 自定义属性,由脚本按主题写入,两边都不跳色。
 */

/** 渲染层写、内联脚本读的 localStorage key(存原始枚举,不是布尔)。 */
export const THEME_BOOT_STORAGE_KEY = 'codemux:theme';

/** 启动画面底色:与种子 `--surface` 逐位一致(深色纯黑 / 浅色 #fcfcfc)。 */
export const BOOT_BACKGROUND_DARK = '#000000';
export const BOOT_BACKGROUND_LIGHT = '#fcfcfc';

/**
 * 首帧前的 `<html>` 底色。刻意与 colorDerivation 的 `--surface` 种子同步
 * (深色 `#000000`、浅色 `#fcfcfc`),这样开发态 CSS 尚未注入的那一两帧、
 * 以及滚动回弹露出的 html 区域,底色都与应用一致 —— 用「近似值」会让浅色主题
 * 的滚动回弹露出灰色。
 */
export const APP_BACKGROUND_DARK = '#000000';
export const APP_BACKGROUND_LIGHT = '#fcfcfc';

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

/** 宿主形态写进 `<html data-host>` 的取值 —— 必须与 `host-form.ts` 的 HostForm 同名。 */
export type BootHostForm = 'desktop' | 'browser' | 'mobile';

/**
 * 圆角超椭圆放大只对桌面壳生效（`html[data-host='desktop']` 才启用
 * `corner-shape: superellipse()`）。所以 `data-host` 必须在**首帧之前**写好，
 * 否则会看到「1 倍圆角 → 1.25 倍圆角」的一次跳变。
 */
export const BOOT_HOST_STORAGE_KEY = 'codemux:host';

export function readBootHostForm(): BootHostForm | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BOOT_HOST_STORAGE_KEY);
    return raw === 'desktop' || raw === 'browser' || raw === 'mobile' ? raw : null;
  } catch {
    return null;
  }
}

/** 渲染层每次判定出宿主形态后调用（与 daemonConnectionStore 的 begin 同步）。 */
export function syncBootHostForm(hostForm: BootHostForm): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.host = hostForm;
  try {
    window.localStorage.setItem(BOOT_HOST_STORAGE_KEY, hostForm);
  } catch {
    // localStorage 不可用时首帧退回默认 1 倍圆角，不影响正确性。
  }
}

/**
 * 注入 index.html `<head>` 的**经典**内联脚本(不是 module):
 * module 会被 defer 到解析之后,那时首帧可能已经画完了,那就失去意义了。
 * 单行 IIFE 是刻意的 —— index.html 里逐字可复制,测试直接整串比对。
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var r=document.documentElement;var s=null;try{s=window.localStorage.getItem('${THEME_BOOT_STORAGE_KEY}')}catch(e){}var q=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var d=s==='Dark'?true:s==='Light'?false:q;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';r.style.backgroundColor=d?'${APP_BACKGROUND_DARK}':'${APP_BACKGROUND_LIGHT}';r.style.setProperty('--boot-bg',d?'${BOOT_BACKGROUND_DARK}':'${BOOT_BACKGROUND_LIGHT}');var h=null;try{h=window.localStorage.getItem('${BOOT_HOST_STORAGE_KEY}')}catch(e){}if(h==='desktop'||h==='browser'||h==='mobile'){r.dataset.host=h}}catch(e){}})();`;
