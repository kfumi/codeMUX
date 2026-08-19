// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('Select', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it('renders portal content above dialogs', () => {
    render(
      <Select defaultOpen value="updated_at">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated_at">更新时间</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole('listbox')).toBeTruthy();
    const portalPanel = Array.from(document.body.querySelectorAll('div')).find((element) =>
      element.className.includes('max-h-96'),
    );
    expect(portalPanel?.className).toContain('z-240');
  });

  it('places the selected check on the right of the option', () => {
    render(
      <Select defaultOpen value="updated_at">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated_at">更新时间</SelectItem>
        </SelectContent>
      </Select>,
    );

    const option = screen.getByRole('option', { name: '更新时间' });
    const checkSlot = option.querySelector('span.absolute');
    expect(checkSlot?.className).toContain('right-2');
    expect(checkSlot?.className).not.toContain('left-2');
    expect(option.className).toContain('cursor-pointer');
  });

  it('does not keep a persistent focus ring after mouse focus', () => {
    render(
      <Select>
        <SelectTrigger aria-label="排序">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated_at">更新时间</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole('combobox', { name: '排序' }).className).toContain('focus-visible:ring-1');
    expect(screen.getByRole('combobox', { name: '排序' }).className).toContain('focus:ring-0');
  });
});
