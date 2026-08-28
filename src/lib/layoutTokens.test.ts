import { describe, expect, it } from 'vitest';

import { LAYOUT_DIVIDER_CLASS } from './layoutTokens';

describe('布局分割线 token', () => {
  it('使用统一的颜色，且完全不透明以保证圆角弯折处与直线段粗细一致', () => {
    expect(LAYOUT_DIVIDER_CLASS).toBe('border-[hsl(var(--layout-divider))]');
  });
});
