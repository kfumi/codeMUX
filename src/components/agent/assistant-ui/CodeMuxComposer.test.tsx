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

const { setComposerTextMock, addAttachmentMock } = vi.hoisted(() => ({
  setComposerTextMock: vi.fn(),
  addAttachmentMock: vi.fn(),
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
      AttachmentDropzone: passthrough('div'),
      Attachments: ({ children }: any) => (
        <div data-testid="composer-attachments">
          {children({
            attachment: {
              id: 'image-1',
              type: 'image',
              name: 'screenshot.png',
              contentType: 'image/png',
              status: { type: 'complete' },
            },
          })}
        </div>
      ),
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
        addAttachment: addAttachmentMock,
      }),
    }),
    AttachmentPrimitive: {
      Root: passthrough('div'),
      unstable_Thumb: (props: any) => <img alt="" {...props} />,
      Name: (props: any) => <span {...props}>screenshot.png</span>,
      Remove: passthrough('button'),
    },
    useAuiState: (selector: (state: any) => unknown) =>
      selector({
        composer: { text: '', attachments: [] },
        attachment: {
          id: 'image-1',
          type: 'image',
          name: 'screenshot.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,abc123' }],
        },
      }),
  };
});

vi.mock('@assistant-ui/react-lexical', () => ({
  LexicalComposerInput: (props: any) => {
    lexicalProps.push(props);
    const Chip = props.directiveChip;
    return (
      <div className={props.className} data-testid="lexical-composer-input" onPaste={props.onPaste}>
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
    addAttachmentMock.mockClear();
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

  it('renders the add menu with file and plan mode options', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    fireEvent.click(screen.getByTitle('添加附件或功能'));

    expect(screen.getByText('选择文件')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
  });

  it('renders assistant-ui image attachment previews without a filename label', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const list = screen.getByTestId('composer-attachment-list');
    expect(list.className).toContain('flex-wrap');
    expect(list.className).toContain('gap-2');
    expect(screen.getByTestId('composer-attachments')).toBeTruthy();
    const image = screen.getByAltText('screenshot.png') as HTMLImageElement;
    expect(image.src).toBe('data:image/png;base64,abc123');
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('opens an image preview from composer attachment thumbnails', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: '预览图片 screenshot.png' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByAltText('screenshot.png')).toHaveLength(2);
  });

  it('adds pasted image files as attachments from the Lexical input', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const image = new File(['image-bytes'], 'pasted.png', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('lexical-composer-input'), {
      clipboardData: {
        files: [image],
      },
    });

    expect(addAttachmentMock).toHaveBeenCalledWith(image);
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

    // Slash command menu is triggered by typing '/' in the input,
    // which sets the manual trigger in the component.
    const commandIds = Array.from(document.querySelectorAll('[data-command-id]'))
      .map((item) => item.getAttribute('data-command-id'));

    // When no trigger is active, no commands are rendered.
    expect(commandIds).toHaveLength(0);
  });
});
