/**
 * 应用前台判定(工单 01/04):未读标记与回焦清除都依赖它。
 *
 * 有 `document` 时读真实焦点;没有 `document`(Node 测试、SSR)时**视为前台** ——
 * 这与改造前的行为一致(「活跃会话不标未读」),既有 store 测试因此无需改动。
 */
export function isAppFocused(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.hasFocus();
}
