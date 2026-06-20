// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeMuxComposer } from './CodeMuxComposer';

const lexicalProps: Array<{
  className?: string;
  directiveChip?: React.FC<{
    directiveId: string;
    directiveType: string;
    label: string;
  }>;
}> = [];

const capturedPopovers: Array<{
  char?: string;
  adapter?: {
    search?: (query: string) => Array<{ id: string }>;
  };
}> = [];

vi.mock('@assistant-ui/react', () => {
  const passthrough =
    (tag = 'div') =>
    ({ children, ...props }: any) => {
      const Component = tag;
      return <Component {...props}>{typeof children === 'function' ? children([]) : children}</Component>;
    };

  return {
    ComposerPrimitive: {
      Root: passthrough('div'),
      Send: passthrough('button'),
      Unstable_TriggerPopoverRoot: passthrough('div'),
      Unstable_TriggerPopover: Object.assign(({ children, ...props }: any) => {
        capturedPopovers.push(props);
        return <div>{typeof children === 'function' ? children([]) : children}</div>;
      }, {
        Directive: () => null,
      }),
      Unstable_TriggerPopoverCategories: passthrough('div'),
      Unstable_TriggerPopoverCategoryItem: passthrough('button'),
      Unstable_TriggerPopoverItems: passthrough('div'),
      Unstable_TriggerPopoverBack: passthrough('button'),
      Unstable_TriggerPopoverItem: passthrough('button'),
    },
    useAui: () => ({
      composer: () => ({
        setText: vi.fn(),
      }),
    }),
    useAuiState: (selector: (state: any) => unknown) =>
      selector({
        composer: { text: '' },
      }),
  };
});

vi.mock('@assistant-ui/react-lexical', () => ({
  LexicalComposerInput: (props: any) => {
    lexicalProps.push(props);
    const Chip = props.directiveChip;
    return (
      <div className={props.className} data-testid="lexical-composer-input">
        <div className="aui-lexical-input" />
        <div className="aui-lexical-placeholder">{props.placeholder}</div>
        {Chip ? (
          <>
            <Chip directiveId="src/App.tsx" directiveType="file" label="App.tsx" />
            <Chip directiveId="review" directiveType="command" label="/review" />
          </>
        ) : null}
      </div>
    );
  },
}));

describe('CodeMuxComposer', () => {
  afterEach(() => {
    lexicalProps.length = 0;
    capturedPopovers.length = 0;
    cleanup();
  });

  it('aligns the Lexical placeholder with the editable input and removes the inner input frame', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const className = lexicalProps[0]?.className ?? '';

    expect(className).toContain('relative');
    expect(className).toContain('[&_.aui-lexical-input]:px-2');
    expect(className).toContain('[&_.aui-lexical-input]:py-1');
    expect(className).toContain('[&_.aui-lexical-placeholder]:left-2');
    expect(className).toContain('[&_.aui-lexical-placeholder]:top-1');
    expect(className).toContain('[&_.aui-lexical-input]:border-0');
    expect(className).toContain('[&_.aui-lexical-input]:shadow-none');
    expect(className).toContain('[&_.aui-lexical-input]:ring-0');
  });

  it('renders file mention chips without a leading icon', () => {
    const { container } = render(<CodeMuxComposer sessionId="session-1" />);

    const chipLabel = screen.getByText('App.tsx');
    const chip = chipLabel.closest('[data-directive-type="file"]');

    expect(chip).toBeTruthy();
    expect(container.querySelector('.lucide-file-code-2')).toBeNull();
    expect(chip?.querySelector('svg')).toBeNull();
  });

  it('renders slash command chips with the command directive treatment', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const chip = screen.getByText('/review').closest('[data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('codemux-directive-command');
  });

  it('uses Codex slash commands for Codex sessions', () => {
    render(<CodeMuxComposer sessionId="session-1" agentKind="codex" />);

    const slashPopover = capturedPopovers.find((popover) => popover.char === '/');
    const commandIds = slashPopover?.adapter?.search?.('').map((item) => item.id) ?? [];

    expect(commandIds).toEqual(expect.arrayContaining(['plan', 'init', 'review']));
    expect(commandIds).not.toContain('permissions');
    expect(commandIds).not.toContain('diff');
    expect(commandIds).not.toContain('model');
    expect(commandIds).not.toContain('security-review');
    expect(commandIds).not.toContain('claude-api');
  });

  it('shows a dismissible plan mode indicator', () => {
    const onClear = vi.fn();
    const { container } = render(
      <CodeMuxComposer
        sessionId="session-1"
        agentKind="codex"
        activeCommandMode={{ id: 'plan', label: '计划' }}
        onClearCommandMode={onClear}
      />,
    );

    expect(screen.getByText('计划')).toBeTruthy();
    const indicator = container.querySelector('[data-active-command-mode="plan"]');
    expect(indicator?.querySelector('.lucide-list-todo')).toBeTruthy();

    fireEvent.click(screen.getByTitle('关闭计划模式'));

    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
