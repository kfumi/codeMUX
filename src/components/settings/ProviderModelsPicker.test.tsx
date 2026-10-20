// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderModelsPicker, modelEntryFromPickerRow } from './ProviderModelsPicker';

describe('ProviderModelsPicker', () => {
  it('adds and removes models from the catalog', () => {
    const onChangeSelected = vi.fn();
    const { rerender } = render(
      <ProviderModelsPicker
        open
        onOpenChange={vi.fn()}
        title="测试 模型"
        source="builtin"
        catalog={[
          { id: 'm1', name: 'Model One' },
          { id: 'm2', name: 'Model Two' },
        ]}
        selected={[]}
        onChangeSelected={onChangeSelected}
      />,
    );

    fireEvent.click(screen.getByLabelText('添加 m1'));
    expect(onChangeSelected).toHaveBeenCalledWith([
      { id: 'm1', name: 'Model One', input_modalities: ['text'] },
    ]);

    rerender(
      <ProviderModelsPicker
        open
        onOpenChange={vi.fn()}
        title="测试 模型"
        source="builtin"
        catalog={[
          { id: 'm1', name: 'Model One' },
          { id: 'm2', name: 'Model Two' },
        ]}
        selected={[{ id: 'm1', name: 'Model One' }]}
        onChangeSelected={onChangeSelected}
      />,
    );

    fireEvent.click(screen.getByLabelText('移除 m1'));
    expect(onChangeSelected).toHaveBeenLastCalledWith([]);
  });

  it('records the catalog window and limits on the models it adds', () => {
    const onChangeSelected = vi.fn();
    render(
      <ProviderModelsPicker
        open
        onOpenChange={vi.fn()}
        title="测试 模型"
        source="api"
        catalog={[
          {
            id: 'glm-5.3-flash',
            name: 'GLM-5.3-Flash',
            input_modalities: ['text', 'image'],
            context_window: 1_000_000,
            max_input_tokens: 800_000,
            max_output_tokens: 131_072,
          },
        ]}
        selected={[]}
        onChangeSelected={onChangeSelected}
      />,
    );

    fireEvent.click(screen.getByLabelText('添加 glm-5.3-flash'));
    // 勾选就把目录的窗口/上限一起带进条目：否则条目只声明 id/名称/模态，发送框
    // 读不到配置窗口，退回 200k 兜底。
    expect(onChangeSelected).toHaveBeenCalledWith([
      {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        input_modalities: ['text', 'image'],
        context_window: 1_000_000,
        max_input_tokens: 800_000,
        max_output_tokens: 131_072,
      },
    ]);
  });

  it('leaves limits undeclared when the row publishes none', () => {
    const entry = modelEntryFromPickerRow({
      id: 'internal-7',
      name: 'Internal 7',
      context_window: 0,
      max_output_tokens: Number.NaN,
    });
    expect(entry).not.toHaveProperty('context_window');
    expect(entry).not.toHaveProperty('max_output_tokens');
    expect(entry.input_modalities).toEqual(['text']);
  });
});
