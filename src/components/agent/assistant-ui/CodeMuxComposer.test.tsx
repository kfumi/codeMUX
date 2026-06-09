// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetText = vi.fn();

vi.mock('@assistant-ui/react', () => {
  const TriggerPopover = ({ className, children }: { className?: string; children?: ReactNode }) => (
    <div data-testid="trigger-popover" className={className}>
      {children}
    </div>
  );

  TriggerPopover.Directive = () => null;

  const TriggerPopoverCategories = ({
    className,
    children,
  }: {
    className?: string;
    children?: (categories: Array<{ id: string; label: string }>) => ReactNode;
  }) => (
    <div data-testid="trigger-categories" className={className}>
      {children?.([{ id: 'builtin', label: '内置' }])}
    </div>
  );

  const TriggerPopoverCategoryItem = ({
    className,
    children,
  }: {
    className?: string;
    children?: ReactNode;
  }) => <div className={className}>{children}</div>;

  const TriggerPopoverItems = ({
    className,
    children,
  }: {
    className?: string;
    children?: (items: Array<{ id: string; label: string; description?: string; metadata?: Record<string, unknown> }>) => ReactNode;
  }) => (
    <div data-testid="trigger-items" className={className}>
      {children?.([{ id: 'deep-research', label: '/deep-research', description: '深度研究', metadata: {} }])}
    </div>
  );

  const TriggerPopoverItem = ({
    className,
    children,
  }: {
    className?: string;
    children?: ReactNode;
  }) => <div className={className}>{children}</div>;

  const TriggerPopoverBack = ({
    className,
    children,
  }: {
    className?: string;
    children?: ReactNode;
  }) => <button className={className}>{children}</button>;

  const Root = ({ className, children }: { className?: string; children?: ReactNode }) => (
    <form className={className}>{children}</form>
  );
  const Input = ({ className }: { className?: string }) => <textarea aria-label="composer-input" className={className} />;
  const Send = ({ className, children }: { className?: string; children?: ReactNode }) => <button className={className}>{children}</button>;
  const Cancel = ({ className, children }: { className?: string; children?: ReactNode }) => <button className={className}>{children}</button>;

  return {
    ComposerPrimitive: {
      Unstable_TriggerPopoverRoot: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Unstable_TriggerPopover: TriggerPopover,
      Unstable_TriggerPopoverCategories: TriggerPopoverCategories,
      Unstable_TriggerPopoverCategoryItem: TriggerPopoverCategoryItem,
      Unstable_TriggerPopoverItems: TriggerPopoverItems,
      Unstable_TriggerPopoverItem: TriggerPopoverItem,
      Unstable_TriggerPopoverBack: TriggerPopoverBack,
      Root,
      Input,
      Send,
      Cancel,
    },
    useAui: () => ({
      composer: () => ({
        setText: mockSetText,
      }),
    }),
    useAuiState: (selector: (state: { composer: { text: string } }) => unknown) =>
      selector({ composer: { text: '/' } }),
  };
});

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: { isRunning: Record<string, boolean> }) => unknown) =>
    selector({ isRunning: { session: false } }),
}));

vi.mock('../../../lib/slashCommands', () => ({
  getAllCommands: () => [
    { name: 'deep-research', description: '深度研究', category: 'builtin' },
  ],
}));

import { CodeMuxComposer } from './CodeMuxComposer';

describe('CodeMuxComposer', () => {
  beforeEach(() => {
    mockSetText.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('constrains the slash command popover height and makes its lists scrollable', () => {
    render(<CodeMuxComposer sessionId="session" modelName="model" />);

    expect(screen.getByTestId('trigger-popover').className).toContain('max-h-[min(28rem,calc(100vh-6rem))]');
    expect(screen.getByTestId('trigger-popover').className).toContain('flex');
    expect(screen.getByTestId('trigger-categories').className).toContain('overflow-y-auto');
    expect(screen.getByTestId('trigger-items').className).toContain('overflow-y-auto');
  });
});
