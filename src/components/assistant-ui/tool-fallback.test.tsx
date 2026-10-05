// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolFallback } from './tool-fallback';

describe('ToolFallbackTrigger', () => {
  it('动作图标带光学对齐微调（CJK 字形带比行盒中心偏上）', () => {
    render(<ToolFallback.Root>
      <ToolFallback.Trigger toolName="Read" />
    </ToolFallback.Root>);

    // CJK 字形在行盒里偏上（雅黑 ascent ≫ descent），图标按盒居中会显得比右边文字低；
    // 用 em 微调补偿，随界面字号缩放。SVG 的 className 是对象，断言走 getAttribute('class')。
    const trigger = screen.getByRole('button', { name: /读取/ });
    const icon = trigger.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('-translate-y-[0.035em]');
    // 图标尺寸也用 em：跟随设置里的界面字号，不能写死像素。
    expect(icon?.getAttribute('class')).toContain('size-[1.08em]');
  });
});
