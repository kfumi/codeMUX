/**
 * 宿主形态（桌面壳 / 浏览器 / 移动）在首帧之前的落点。
 *
 * 从 `themeBoot.ts` 拆出来的：它和主题无关，唯一消费方是
 * `stores/daemonConnectionStore.ts`。留在 themeBoot 里会让「外观模块」混进一个
 * 与外观无关的持久化概念。
 *
 * 为什么必须在首帧之前写好：圆角超椭圆放大只对桌面壳生效
 * （`html[data-host='desktop']` 才启用 `corner-shape: superellipse()`），
 * 写晚了会看到「1 倍圆角 → 1.25 倍圆角」的一次跳变。
 */

/** 宿主形态写进 `<html data-host>` 的取值 —— 必须与 `host-form.ts` 的 HostForm 同名。 */
export type BootHostForm = 'desktop' | 'browser' | 'mobile';

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
