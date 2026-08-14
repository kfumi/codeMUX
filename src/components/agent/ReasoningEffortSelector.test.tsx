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
});
