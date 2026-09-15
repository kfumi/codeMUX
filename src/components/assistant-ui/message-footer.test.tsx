// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock('../../hooks/useIsNarrowViewport', () => ({
  useIsNarrowViewport: () => narrowState.value,
}));

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
  afterEach(() => {
    cleanup();
  });

  it('can stay hidden until the message row is hovered', () => {
    render(<MessageFooter timestamp={Date.parse('2026-06-12T21:40:00+08:00')} revealOnHover />);

    const footer = screen.getByText(/21:40/).closest('[data-message-footer]');

    expect(footer?.className).toContain('opacity-0');
    expect(footer?.className).toContain('group-hover/message-row:opacity-100');
  });

  it('stays visible on narrow viewports even with revealOnHover (no hover on touch)', () => {
    narrowState.value = true;
    render(<MessageFooter timestamp={Date.parse('2026-06-12T21:40:00+08:00')} revealOnHover />);

    const footer = screen.getByText(/21:40/).closest('[data-message-footer]');

    expect(footer?.className).not.toContain('opacity-0');
    expect(footer?.className).not.toContain('group-hover');
    expect(footer?.className).not.toContain('opacity-100');
  });

  it('renders duration without a turn status label', () => {
    render(<MessageFooter timestamp={Date.parse('2026-06-12T21:40:00+08:00')} stats={{ durationMs: 1200 }} />);

    expect(screen.getByText(/耗时 1s/)).toBeTruthy();
    expect(screen.queryByText(/token/)).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByText('Interrupted')).toBeNull();
  });

  it('minimal variant copies explicit text and omits duration, fork, and debug', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <MessageFooter
        variant="minimal"
        timestamp={Date.parse('2026-06-12T21:40:00+08:00')}
        copyText="子智能体结论"
        revealOnHover
        sessionId="session-1"
        canFork
        onFork={() => undefined}
        stats={{ durationMs: 1200 }}
      />,
    );

    expect(screen.getByText(/21:40/)).toBeTruthy();
    expect(screen.queryByText(/耗时/)).toBeNull();
    expect(screen.queryByRole('button', { name: '从此回复创建分支' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制排查问题提示词' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('子智能体结论');
    });
  });
});
