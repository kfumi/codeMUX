/**
 * Token 数量的中文单位格式化（使用统计页口径）。
 * - < 1万：原数
 * - 1万 ~ 1亿：万，最多 1 位小数（3600万 / 360万 / 3.6万）
 * - ≥ 1亿：亿，最多 2 位小数（14.36亿 / 1.2亿）
 */
export function formatTokenCount(n: number): string {
  if (n >= 1e8) {
    return `${trimTrailingZeros((n / 1e8).toFixed(2))}亿`;
  }
  if (n >= 1e4) {
    const w = n / 1e4;
    if (Math.round(w * 10) >= 100_000) {
      // 万档四舍五入进位到 10000万 时直接升到亿档，避免出现 10000万。
      return `${trimTrailingZeros((n / 1e8).toFixed(2))}亿`;
    }
    return `${trimTrailingZeros(w.toFixed(1))}万`;
  }
  return String(n);
}

function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
