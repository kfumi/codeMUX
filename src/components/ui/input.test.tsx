// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input } from './input';

describe('Input', () => {
  it('keeps a visible border on the quiet muted fill', () => {
    // 输入框与 SelectTrigger 是同一套「灰底安静」控件语言:底色靠灰填充,
    // 轮廓靠 border-input。边框必须可见,否则在设置页的软瓦片上和底色融为一体。
    render(<Input aria-label="名称" />);

    const input = screen.getByLabelText('名称').className;
    expect(input).toContain('border-input');
    expect(input).not.toContain('border-transparent');
  });
});
