// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeMuxComposer } from './CodeMuxComposer';

const lexicalProps: Array<{
  className?: string;
  formatter?: {
    parse: (text: string) => Array<{ kind: string; type?: string; id?: string; label?: string; text?: string }>;
  };
  directiveChip?: React.FC<{
    directiveId: string;
    directiveType: string;
    label: string;
  }>;
}> = [];

const { setComposerTextMock } = vi.hoisted(() => ({
  setComposerTextMock: vi.fn(),
}));

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
        setText: setComposerTextMock,
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
    setComposerTextMock.mockClear();
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

  it('renders file mention chips with a file icon', () => {
    const { container } = render(<CodeMuxComposer sessionId="session-1" />);

    const chipLabel = screen.getByText('App.tsx');
    const chip = chipLabel.closest('[data-directive-type="file"]');

    expect(chip).toBeTruthy();
    // Now file chips have a leading file icon
    const icon = chip?.querySelector('svg.lucide-file');
    expect(icon).toBeTruthy();
  });

  it('renders slash command chips with the command directive treatment', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const chip = screen.getByText('/review').closest('[data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('codemux-directive-command');
  });

  it('does not render assistant-ui unstable trigger popovers', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    expect(capturedPopovers).toHaveLength(0);
  });

  it('inserts a selected slash command by updating composer text directly', () => {
    render(<CodeMuxComposer sessionId="session-1" agentKind="codex" />);

    fireEvent.click(screen.getByText('/'));
    fireEvent.click(document.querySelector('[data-command-id="review"]')!);

    expect(setComposerTextMock).toHaveBeenLastCalledWith('/review ');
  });

  it('parses slash and file directives for Lexical chips without trigger resources', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const segments = lexicalProps[0]?.formatter?.parse('/review @src/App.tsx plain') ?? [];

    expect(segments).toEqual([
      { kind: 'mention', type: 'command', label: '/review', id: 'review' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', type: 'file', label: 'App.tsx', id: 'src/App.tsx' },
      { kind: 'text', text: ' plain' },
    ]);
  });

  it('uses Codex slash commands for Codex sessions', () => {
    render(<CodeMuxComposer sessionId="session-1" agentKind="codex" />);

    fireEvent.click(screen.getByText('/'));
    const commandIds = Array.from(document.querySelectorAll('[data-command-id]'))
      .map((item) => item.getAttribute('data-command-id'));

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
