/**
 * 活跃热力图的颜色分档。
 *
 * 深度依据是「当天消耗的 Token 总量」（输入 + 缓存 + 输出），不是会话数。
 * 0 档表示当天没有消耗；1~4 档按当前窗口内「有消耗的日」的 Token 量分位数切分。
 * 早期用的是固定绝对阈值（50K/200K/500K），在日消耗量级差好几个数量级的账号上会
 * 退化成「所有活跃日都在最高档、整块颜色一样」；分位数则始终把窗口内的差异铺开。
 */

/** 档位上界取 25/50/75 分位，把活跃日切成四档（每档约 25%）。 */
const LEVEL_QUANTILES = [0.25, 0.5, 0.75];

/** 最高档编号（0 档为空档）。 */
export const MAX_HEATMAP_LEVEL = LEVEL_QUANTILES.length + 1;

/**
 * 返回三个档位上界 `[b1, b2, b3]`：`t <= b1` 为 1 档、`b1 < t <= b2` 为 2 档、
 * `b2 < t <= b3` 为 3 档、`t > b3` 为 4 档。窗口内没有任何消耗时返回 `null`；
 * 活跃日太少或数值高度重复时分位会塌缩，此时退回最小值到最大值的等比切档。
 */
export function buildTokenThresholds(dailyTokens: Iterable<number>): number[] | null {
  const active = [...dailyTokens].filter((value) => value > 0).sort((a, b) => a - b);
  if (active.length === 0) return null;

  const pick = (quantile: number) =>
    active[Math.min(active.length - 1, Math.max(0, Math.ceil(quantile * active.length) - 1))];
  const quantiles = LEVEL_QUANTILES.map(pick);
  if (new Set(quantiles).size === LEVEL_QUANTILES.length) return quantiles;

  const min = active[0];
  const max = active[active.length - 1];
  const ratio = Math.pow(max / min, 1 / (LEVEL_QUANTILES.length + 1));
  return [min * ratio, min * ratio ** 2, min * ratio ** 3];
}

/**
 * 把某天的 Token 量映射到 0~4 档。
 * `thresholds` 为 `null`（窗口内无消耗）时，有消耗的日按 1 档处理。
 */
export function tokenLevel(tokens: number, thresholds: number[] | null): number {
  if (tokens <= 0) return 0;
  if (!thresholds || thresholds.length === 0) return 1;

  let level = 1;
  for (const threshold of thresholds) {
    // 严格大于：否则分位值自身会被算进下一档，把最浅的一档挤空。
    if (tokens > threshold) level += 1;
  }
  return Math.min(level, MAX_HEATMAP_LEVEL);
}
