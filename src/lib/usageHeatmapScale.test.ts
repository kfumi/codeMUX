import { describe, expect, it } from 'vitest';

import { MAX_HEATMAP_LEVEL, buildTokenThresholds, tokenLevel } from './usageHeatmapScale';

describe('buildTokenThresholds', () => {
  it('把量级差异很大的活跃日铺开到四档，而不是全部落到最高档', () => {
    // 真实账号的量级：日消耗 5M~150M。旧固定阈值 50K/200K/500K 会把这些日子全涂成最深色。
    const daily = [5_000_000, 12_000_000, 20_000_000, 45_000_000, 150_000_000];
    const thresholds = buildTokenThresholds(daily);

    const levels = daily.map((tokens) => tokenLevel(tokens, thresholds));
    expect(new Set(levels).size).toBe(4);
    expect(levels[0]).toBe(1);
    expect(levels[levels.length - 1]).toBe(4);
  });

  it('零消耗的日不参与分位，并保持 0 档', () => {
    const thresholds = buildTokenThresholds([0, 0, 0, 1_000, 2_000, 3_000, 4_000]);

    expect(tokenLevel(0, thresholds)).toBe(0);
    expect(tokenLevel(1_000, thresholds)).toBe(1);
    expect(tokenLevel(4_000, thresholds)).toBe(4);
  });

  it('活跃日太少时分位塌缩，退回等比切档但仍有区分度', () => {
    const thresholds = buildTokenThresholds([1_000_000, 100_000_000]);
    const [b1, b2, b3] = thresholds ?? [];

    expect(b1).toBeLessThan(b2);
    expect(b2).toBeLessThan(b3);
    expect(tokenLevel(1_000_000, thresholds)).toBe(1);
    expect(tokenLevel(100_000_000, thresholds)).toBe(4);
  });

  it('窗口内没有消耗时返回 null，档位不会越界', () => {
    expect(buildTokenThresholds([])).toBeNull();
    expect(buildTokenThresholds([0, 0])).toBeNull();
    expect(tokenLevel(0, null)).toBe(0);
    // 阈值缺失但有消耗（Token 数据尚未加载完）时退化为最低档，不炸。
    expect(tokenLevel(123, null)).toBe(1);

    const thresholds = buildTokenThresholds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(tokenLevel(Number.MAX_SAFE_INTEGER, thresholds)).toBe(MAX_HEATMAP_LEVEL);
  });
});
