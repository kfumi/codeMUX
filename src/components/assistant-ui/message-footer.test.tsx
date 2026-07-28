// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MessageFooter } from './message-footer';

vi.mock('@assistant-ui/react', () => ({
  ActionBarPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Copy: ({ children, copiedDuration: _copiedDuration, ...props }: any) => <button {...props}>{children}</button>,
  },
  useAuiState: (selector: (state: any) => unknown) =>
    selector({ message: { isCopied: false } }),
}));

describe('MessageFooter', () => {
  it('can stay hidden until the message row is hovered', () => {
    render(<MessageFooter timestamp={Date.parse('2026-06-12T21:40:00+08:00')} revealOnHover />);

    const footer = screen.getByText(/21:40/).closest('[data-message-footer]');

    expect(footer?.className).toContain('opacity-0');
    expect(footer?.className).toContain('group-hover/message-row:opacity-100');
  });

  it('renders interruption status without inventing statistics', () => {
    render(<MessageFooter status="interrupted" />);

    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(screen.queryByText(/耗时/)).toBeNull();
  });
});
