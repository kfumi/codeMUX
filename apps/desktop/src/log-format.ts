//! 日志行时间戳格式:本地时区 `YYYY-MM-DD HH:MM:SS.mmm`(daemon.log /
//! renderer.log / supervisor 标记行统一使用,便于肉眼对齐排查时间线)。

/** 单条日志文本上限:超出截断并标注,避免巨型 payload/整份文件进日志。 */
export const MAX_LOG_TEXT_CHARS = 8 * 1024;

/**
 * 把单条日志文本钳制到 `maxChars`(UTF-16 长度,与 slice 一致);
 * 截断时保留前段并追加 `...[truncated N chars]`。
 */
export function clampLogText(text: string, maxChars: number = MAX_LOG_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  // 不要从代理对中间切开,否则会留下半个 emoji / 生僻字。
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}...[truncated ${text.length - cut} chars]`;
}

/** 格式化为本地时区时间戳,如 `2026-09-13 03:20:47.481`。 */
export function formatLocalTimestamp(date: Date): string {
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} `
    + `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
    + `.${date.getMilliseconds().toString().padStart(3, '0')}`;
}
