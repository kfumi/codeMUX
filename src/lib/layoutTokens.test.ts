import { describe, expect, it } from 'vitest';

import { LAYOUT_DIVIDER_CLASS } from './layoutTokens';

describe('布局分割线 token', () => {
  it('使用统一的颜色和透明度', () => {
    expect(LAYOUT_DIVIDER_CLASS).toBe('border-[hsl(var(--layout-divider)/0.72)]');
  });
});
