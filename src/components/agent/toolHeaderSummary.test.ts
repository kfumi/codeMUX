import { describe, expect, it } from 'vitest';

import { getDisplayableArgs, getToolHeaderSummary } from './toolHeaderSummary';

describe('toolHeaderSummary', () => {
  it('shows update_plan explanation as the header summary and omits it from displayable args', () => {
    const input = {
      explanation: '同步最新进度并收尾验证',
      plan: [
        { step: '补充测试', status: 'completed' },
        { step: '整理文案', status: 'completed' },
      ],
    };

    const summary = getToolHeaderSummary('update_plan', input);

    expect(summary.text).toBe('同步最新进度并收尾验证');
    expect(summary.consumedKeys).toEqual(['explanation']);
    expect(getDisplayableArgs(input, summary.consumedKeys)).toEqual({
      plan: input.plan,
    });
  });
});
