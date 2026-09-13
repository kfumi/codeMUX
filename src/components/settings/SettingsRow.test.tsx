// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsRow } from './SettingsRow';

afterEach(() => {
  cleanup();
});

describe('SettingsRow', () => {
  it('渲染标题、说明与控件', () => {
    render(
      <SettingsRow
        label="精简 AI 输出"
        description="开启后只保留最终总结。"
        control={<button type="button">开关</button>}
      />,
    );

    expect(screen.getByText('精简 AI 输出')).toBeTruthy();
    expect(screen.getByText('开启后只保留最终总结。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开关' })).toBeTruthy();
  });

  it('窄屏下拉类控件整行铺开,宽屏回到右列', () => {
    const { container } = render(
      <SettingsRow label="提示音" description="说明" control={<span data-testid="ctl">控件</span>} />,
    );

    const row = container.firstElementChild as HTMLElement;
    const controlCell = screen.getByTestId('ctl').parentElement as HTMLElement;

    expect(row.className).toContain('grid');
    // 手机端:控件换行到标题与说明下方,占满整行。
    expect(controlCell.className).toContain('col-span-2');
    expect(controlCell.className).toContain('row-start-3');
    // 宽屏:回到右列并跨两行,保持改动前的左右分栏。
    expect(controlCell.className).toContain('sm:col-start-2');
    expect(controlCell.className).toContain('sm:row-span-2');
  });

  it('紧凑控件在窄屏留在标题右侧', () => {
    render(
      <SettingsRow inlineControl label="提示音" description="说明" control={<span data-testid="ctl">控件</span>} />,
    );

    const controlCell = screen.getByTestId('ctl').parentElement as HTMLElement;
    expect(controlCell.className).toContain('col-start-2');
    expect(controlCell.className).toContain('row-start-1');
    expect(controlCell.className).toContain('justify-self-end');
  });

  it('surface 自带卡片底色,divided 画分隔线', () => {
    const { container } = render(
      <SettingsRow surface divided label="忽略证书校验" control={<span>控件</span>} />,
    );

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('rounded-xl');
    expect(row.className).toContain('bg-muted/40');
    expect(row.className).toContain('border-t');
  });
});
