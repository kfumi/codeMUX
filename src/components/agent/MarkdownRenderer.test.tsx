// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock('../../hooks/useIsNarrowViewport', () => ({
  useIsNarrowViewport: () => narrowState.value,
}));

import { MarkdownRenderer } from './MarkdownRenderer';

const CODE_BLOCK = '```js\nconst answer = 42;\n```';

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    narrowState.value = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('reveals the code copy button on hover for pointer devices', () => {
    render(<MarkdownRenderer content={CODE_BLOCK} />);

    const copy = screen.getByRole('button', { name: '复制' });
    expect(copy.className).toContain('opacity-0');
    expect(copy.className).toContain('group-hover:opacity-100');
  });

  it('always shows the code copy button on narrow viewports (no hover on touch)', () => {
    narrowState.value = true;
    render(<MarkdownRenderer content={CODE_BLOCK} />);

    const copy = screen.getByRole('button', { name: '复制' });
    expect(copy.className).toContain('opacity-100');
    expect(copy.className).not.toContain('opacity-0');
  });
});
