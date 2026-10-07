/**
 * `app://` 协议处理器对 `Range` 请求的解析(静态媒体/大文件分段读取)。
 *
 * 抽出来单独测的原因同 vendor-assets.ts:main.ts 会拉起 Electron 主进程模块,
 * 不适合在单测里 import。daemon 侧走 tower-http 的 `ServeDir`,Range 与
 * Content-Length 由它自动处理;壳侧手写的处理器必须补齐,否则媒体元素
 * (设置页「试听」/ 任务提示音)在超过 Chromium 缓冲阈值时会被判成
 * `MEDIA_ELEMENT_ERROR: Format error`——生产态哑火,dev 走 Vite http 正常。
 */

export interface ByteRange {
  /** 起始偏移(含)。 */
  start: number;
  /** 结束偏移(含)。 */
  end: number;
}

/**
 * 解析单段 `Range: bytes=...` 头。
 *
 * 支持 `bytes=start-end`、`bytes=start-`(到文件末尾)、`bytes=-suffix`(末尾 N 字节);
 * 多段、非法语法、起点越界一律返回 `null`,调用方退化为整文件 200 —— 与
 * tower-http `ServeDir` 的保守行为一致。
 */
export function parseByteRange(header: string | null | undefined, total: number): ByteRange | null {
  if (!header || total <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    return null;
  }
  if (match[1] === '') {
    // 后缀范围:bytes=-N 表示最后 N 字节。
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) {
      return null;
    }
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? total - 1 : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= total) {
    return null;
  }
  return { start, end: Math.min(end, total - 1) };
}
