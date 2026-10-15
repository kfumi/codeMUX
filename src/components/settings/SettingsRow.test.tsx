// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsCard, SettingsRow } from './SettingsRow';

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

  it('没有说明的行,控件不跨两行 —— 否则标题会被顶到行的上四分之一', () => {
    const { container } = render(
      <SettingsRow label="模式" control={<span data-testid="ctl">控件</span>} />,
    );

    const controlCell = screen.getByTestId('ctl').parentElement as HTMLElement;
    expect(controlCell.className).not.toContain('sm:row-span-2');
    // 单行内 items-center 就能把标题与控件对齐到同一条中线上。
    expect((container.firstElementChild as HTMLElement).className).toContain('items-center');
  });

  it('可以用 controlClassName 放宽控件列的宽度上限', () => {
    render(
      <>
        <SettingsRow label="默认" control={<span data-testid="ctl-default">控件</span>} />
        <SettingsRow
          label="模式"
          controlClassName="sm:max-w-none"
          control={<span data-testid="ctl-wide">控件</span>}
        />
      </>,
    );

    const defaultCell = screen.getByTestId('ctl-default').parentElement as HTMLElement;
    expect(defaultCell.className).toContain('sm:max-w-60');

    // 宽控件(一排 272px 的缩略图)要放开这个上限;tailwind-merge 会把同族里
    // 先出现的 `sm:max-w-60` 去掉,只留最后那一档。
    const wideCell = screen.getByTestId('ctl-wide').parentElement as HTMLElement;
    expect(wideCell.className).toContain('sm:max-w-none');
    expect(wideCell.className).not.toContain('sm:max-w-60');
  });

  it('surface 自带卡片描边,divided 画分隔线', () => {
    const { container } = render(
      <SettingsRow surface divided label="忽略证书校验" control={<span>控件</span>} />,
    );

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('rounded-xl');
    // Codex 式卡片:平面 + 发丝描边,不再靠 `settings-tile` 的深底色分层。
    expect(row.className).toContain('border-border');
    expect(row.className).toContain('bg-[hsl(var(--surface-1))]');
    expect(row.className).toContain('border-t');
  });

  it('SettingsCard 把多行收进同一张卡并裁掉圆角外的分隔线', () => {
    const { container } = render(
      <SettingsCard>
        <SettingsRow label="第一行" control={<span>a</span>} />
        <SettingsRow divided label="第二行" control={<span>b</span>} />
      </SettingsCard>,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('overflow-hidden');
    expect(card.className).toContain('rounded-xl');
    expect(card.children).toHaveLength(2);
  });
});
