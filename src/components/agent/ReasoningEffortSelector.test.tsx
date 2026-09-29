// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ReasoningEffortSelector } from './ReasoningEffortSelector';

describe('ReasoningEffortSelector', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the current effort and all six options in a select', () => {
    const onChange = vi.fn();
    render(<ReasoningEffortSelector value="high" onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }));

    expect(screen.getByRole('option', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '中' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '极高' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '最高' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '关闭' }).className).toContain('cursor-pointer');

    fireEvent.click(screen.getByRole('option', { name: '关闭' }));
    expect(onChange).toHaveBeenCalledWith('none');
  });

  it('does not keep a colored focus ring on the trigger', () => {
    render(<ReasoningEffortSelector value="high" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: '思考强度' });
    expect(trigger.className).toContain('cursor-pointer');
    expect(trigger.className).toContain('focus-visible:ring-0');
    expect(trigger.className).not.toMatch(/(?:^|\s)focus-visible:ring-2(?:\s|$)/);
  });

  it('falls back to high for unknown stored values', () => {
    render(<ReasoningEffortSelector value={'mystery' as 'high'} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: '思考强度' }).textContent).toContain('高');
  });

  it('offers only the levels the model declares', () => {
    render(
      <ReasoningEffortSelector
        value="high"
        onChange={vi.fn()}
        options={[
          { id: 'none', name: '关闭' },
          { id: 'low', name: '低' },
          { id: 'high', name: '高' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }));
    expect(screen.getByRole('option', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '极高' })).toBeNull();
    expect(screen.queryByRole('option', { name: '最高' })).toBeNull();
  });

  it('snaps a stored level the model does not offer onto the nearest one', () => {
    // Switching models can leave the session holding a level the new model
    // cannot honour; the trigger must not advertise it.
    render(
      <ReasoningEffortSelector
        value="max"
        onChange={vi.fn()}
        options={[
          { id: 'none', name: '关闭' },
          { id: 'low', name: '低' },
          { id: 'high', name: '高' },
        ]}
      />,
    );
    expect(screen.getByRole('combobox', { name: '思考强度' }).textContent).toContain('高');
  });

  it('snaps upward when no lower level is offered', () => {
    render(
      <ReasoningEffortSelector
        value="low"
        onChange={vi.fn()}
        options={[
          { id: 'none', name: '关闭' },
          { id: 'xhigh', name: '极高' },
        ]}
      />,
    );
    expect(screen.getByRole('combobox', { name: '思考强度' }).textContent).toContain('极高');
  });
});
