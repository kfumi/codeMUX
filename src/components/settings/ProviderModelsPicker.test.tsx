// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderModelsPicker } from './ProviderModelsPicker';

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
});
