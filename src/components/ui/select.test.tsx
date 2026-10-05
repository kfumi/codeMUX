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

  it('trigger keeps a visible border on the quiet muted fill', () => {
    // 触发器是「灰底安静」风格,但边框必须可见(border-input):无边框时设置页的
    // 软瓦片上灰底几乎贴底色,下拉看起来没有轮廓(用户反馈过)。
    render(
      <Select>
        <SelectTrigger aria-label="触发器边框">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );

    const trigger = screen.getByRole('combobox', { name: '触发器边框' }).className;
    expect(trigger).toContain('border-input');
    expect(trigger).not.toContain('border-transparent');
  });
});
