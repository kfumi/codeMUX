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
    expect(portalPanel?.className).toContain('z-[240]');
  });
});
