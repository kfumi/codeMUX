//! 日志行时间戳格式:本地时区 `YYYY-MM-DD HH:MM:SS.mmm`(daemon.log /
//! renderer.log / supervisor 标记行统一使用,便于肉眼对齐排查时间线)。

/** 格式化为本地时区时间戳,如 `2026-09-13 03:20:47.481`。 */
export function formatLocalTimestamp(date: Date): string {
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} `
    + `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
    + `.${date.getMilliseconds().toString().padStart(3, '0')}`;
}
