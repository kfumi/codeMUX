// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from './dialog';

function findLayeredElement(zToken: string): Element | undefined {
  return Array.from(document.body.querySelectorAll('*')).find((el) =>
    (el.getAttribute('class') ?? '').includes(zToken),
  );
}

describe('DialogContent layering', () => {
  it('keeps content at default z-50 when no overlay z-index is given', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>默认</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('z-50');
    expect(dialog.className).toContain('dark:bg-[hsl(var(--surface-3))]');
    expect(dialog.className).toContain('dark:border-[hsl(var(--surface-edge))]');
  });

  it('raises content z-index to match overlayClassName so content is not hidden behind the mask', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent overlayClassName="z-230">
          <DialogTitle>提升</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(findLayeredElement('z-230')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('z-230');
    expect(dialog.className).not.toContain('z-50');
  });

  it('supports arbitrary z-index values like z-[250]', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent overlayClassName="z-[250] bg-black/72">
          <DialogTitle>任意值</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('z-[250]');
  });

  it('lets an explicit content z-index override the overlay-derived one', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent overlayClassName="z-230" className="z-[240]">
          <DialogTitle>覆盖</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('z-[240]');
    expect(dialog.className).not.toContain('z-230');
  });
});
