// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { registerSkillCommands } from '../../../lib/slashCommands';
import { usePreviewStore } from '../../../stores/previewStore';
import { TooltipProvider } from '../../ui/tooltip';
import { CODEMUX_FORMATTER, CodeMuxComposer, createCodeMuxFormatter, findLatestPendingProposedPlan } from './CodeMuxComposer';

let composerText = '';

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

const { setComposerTextMock, addAttachmentMock, sendToolResponseMock, composerSendMock, updatePermissionsMock } = vi.hoisted(() => ({
  setComposerTextMock: vi.fn(),
  addAttachmentMock: vi.fn(),
  sendToolResponseMock: vi.fn(),
  composerSendMock: vi.fn(),
  updatePermissionsMock: vi.fn(),
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
        setText: (text: string) => {
          composerText = text;
          setComposerTextMock(text);
        },
        send: composerSendMock,
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
        composer: { text: composerText, attachments: [] },
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
            <Chip directiveId="review" directiveType="command" label="review" />
          </>
        ) : null}
      </div>
    );
  },
}));

vi.mock('../../../lib/tauri', () => ({
  agentApi: {
    sendToolResponse: sendToolResponseMock,
  },
  sessionApi: {
    updatePermissions: updatePermissionsMock,
  },
  fileApi: {
    listDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const pendingQuestionEvents: AgentMessage[] = [
  {
    kind: 'ask_user_question',
    data: {
      tool_use_id: 'question-1',
      questions: [{
        header: '审批',
        question: '允许读取 Codex 官方手册吗？',
        options: [
          { label: '是', description: '继续读取文档。' },
          { label: '否', description: '跳过这一步。' },
        ],
      }],
    },
  },
];

const answeredQuestionEvents: AgentMessage[] = [
  ...pendingQuestionEvents,
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'question-1', content: '是' }],
      },
      parent_tool_use_id: null,
    } as any,
  },
];

describe('CodeMuxComposer', () => {
  afterEach(() => {
    lexicalProps.length = 0;
    capturedPopovers.length = 0;
    composerText = '';
    setComposerTextMock.mockClear();
    addAttachmentMock.mockClear();
    sendToolResponseMock.mockReset();
    composerSendMock.mockClear();
    updatePermissionsMock.mockReset();
    useAgentStore.setState({ events: {}, forceStopped: {} });
    usePreviewStore.setState({ treeRoot: null });
    registerSkillCommands([]);
    cleanup();
  });

  it('serializes Codex skill directives with the complete SKILL.md path', () => {
    const result = CODEMUX_FORMATTER.serialize({
      id: 'superpowers:brainstorming',
      type: 'command',
      label: '/superpowers:brainstorming',
      metadata: {
        category: 'skill',
        agentKind: 'codex',
        filePath: 'C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming',
      },
    });

    expect(result).toBe('[$superpowers:brainstorming](C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming\\SKILL.md) ');
  });

  it('preserves the Codex skill path after directive text is parsed again', () => {
    const skillPath = 'C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming';
    registerSkillCommands([{
      name: 'superpowers:brainstorming',
      description: 'Brainstorming',
      apps: { claude: true, codex: true, gemini: false, opencode: false },
      diskPath: skillPath,
    }]);
    const formatter = createCodeMuxFormatter('codex');
    const segments = formatter.parse('[$superpowers:brainstorming](C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming\\SKILL.md)');
    const mention = segments.find((segment) => segment.kind === 'mention');

    expect(mention && formatter.serialize({
      id: mention.id,
      type: mention.type,
      label: mention.label,
    })).toBe('[$superpowers:brainstorming](C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming\\SKILL.md) ');
  });

  it('keeps Claude Code skill directives using the command name', () => {
    const result = CODEMUX_FORMATTER.serialize({
      id: 'superpowers:brainstorming',
      type: 'command',
      label: '/superpowers:brainstorming',
      metadata: {
        category: 'skill',
        agentKind: 'claude_code',
        filePath: 'C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming',
      },
    });

    expect(result).toBe('[$superpowers:brainstorming](superpowers:brainstorming) ');
  });

  it('aligns the Lexical placeholder with the editable input and removes the inner input frame', () => {
    const { container } = render(<CodeMuxComposer sessionId="session-1" />);

    const className = lexicalProps[0]?.className ?? '';

    expect((container.firstElementChild as HTMLElement | null)?.style.maxWidth).toBe('var(--content-width, 52rem)');
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

    const chip = screen.getByText('review').closest('[data-directive-type="command"]');

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
      { kind: 'mention', type: 'command', label: 'review', id: 'review' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', type: 'file', label: 'App.tsx', id: 'src/App.tsx' },
      { kind: 'text', text: ' plain' },
    ]);
  });

  it('parses chip-format commands as command directive chips', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const segments = lexicalProps[0]?.formatter?.parse('[$review](review) args') ?? [];

    expect(segments).toEqual([
      { kind: 'mention', type: 'command', label: 'review', id: 'review' },
      { kind: 'text', text: ' args' },
    ]);
  });

  it('parses chip-format skill commands as command directive chips', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const segments = lexicalProps[0]?.formatter?.parse('[$skill-installer](C:\\skills\\SKILL.md) install') ?? [];

    expect(segments).toEqual([
      { kind: 'mention', type: 'command', label: 'skill-installer', id: 'skill-installer' },
      { kind: 'text', text: ' install' },
    ]);
  });

  it('parses colon skill commands as command directive chips', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const segments = lexicalProps[0]?.formatter?.parse('/superpowers:brainstorming 测试') ?? [];

    expect(segments).toEqual([
      { kind: 'mention', type: 'command', label: 'superpowers:brainstorming', id: 'superpowers:brainstorming' },
      { kind: 'text', text: ' 测试' },
    ]);
  });

  it('does not parse inline URL separators in logs as file directive chips', () => {
    render(<CodeMuxComposer sessionId="session-1" />);

    const text =
      '[2026-07-03][10:24:15][INFO][webview:emit@http://localhost:1420/src/lib/logger.ts:53:17] [agentNotifications] Notification candidate';
    const segments = lexicalProps[0]?.formatter?.parse(text) ?? [];

    expect(segments).toEqual([{ kind: 'text', text }]);
  });

  it('opens slash suggestions for a trigger at the cursor', () => {
    composerText = '/rev';

    render(<CodeMuxComposer sessionId="session-1" />);

    expect(document.querySelector('[data-command-id="review"]')).toBeTruthy();
  });

  it('does not open slash suggestions when cursor is away from trigger', () => {
    composerText = '/rev 已有文本';

    render(<CodeMuxComposer sessionId="session-1" />);

    expect(document.querySelector('[data-command-id]')).toBeNull();
  });

  it('closes slash suggestions after selecting a command', () => {
    composerText = '/rev';

    render(<CodeMuxComposer sessionId="session-1" />);

    fireEvent.click(document.querySelector('[data-command-id="review"]') as Element);

    expect(setComposerTextMock).toHaveBeenCalledWith('[$review](review) ');
    expect(document.querySelector('[data-command-id="review"]')).toBeNull();
  });

  it('closes file suggestions after selecting a file reference', () => {
    composerText = '@Ap';
    usePreviewStore.setState({
      treeRoot: [{ name: 'App.tsx', path: 'D:/project/codeMUX/src/App.tsx', isDir: false }],
    });

    render(<CodeMuxComposer sessionId="session-1" projectPath="D:/project/codeMUX" />);

    fireEvent.click(document.querySelector('[data-file-id="App.tsx"]') as Element);

    expect(setComposerTextMock).toHaveBeenCalledWith('[App.tsx](App.tsx) ');
    expect(document.querySelector('[data-file-id="App.tsx"]')).toBeNull();
  });

  it('does not reopen file suggestions for completed file references while typing after them', () => {
    composerText = '@docs 这是什么目录 @src/App.tsx 这是什么文件';
    usePreviewStore.setState({
      treeRoot: [
        { name: 'docs', path: 'D:/project/codeMUX/docs', isDir: true },
        { name: 'src', path: 'D:/project/codeMUX/src', isDir: true, children: [
          { name: 'App.tsx', path: 'D:/project/codeMUX/src/App.tsx', isDir: false },
        ] },
      ],
    });

    render(<CodeMuxComposer sessionId="session-1" projectPath="D:/project/codeMUX" />);

    expect(document.querySelector('[data-file-id]')).toBeNull();
  });

  it('closes file suggestions with Escape', () => {
    composerText = '@Ap';
    usePreviewStore.setState({
      treeRoot: [{ name: 'App.tsx', path: 'D:/project/codeMUX/src/App.tsx', isDir: false }],
    });

    render(<CodeMuxComposer sessionId="session-1" projectPath="D:/project/codeMUX" />);

    expect(document.querySelector('[data-file-id="App.tsx"]')).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('lexical-composer-input'), { key: 'Escape' });

    expect(document.querySelector('[data-file-id="App.tsx"]')).toBeNull();
  });

  it('closes file suggestions when clicking outside the composer', () => {
    composerText = '@Ap';
    usePreviewStore.setState({
      treeRoot: [{ name: 'App.tsx', path: 'D:/project/codeMUX/src/App.tsx', isDir: false }],
    });

    render(
      <div>
        <button type="button" data-testid="outside-button">外部区域</button>
        <CodeMuxComposer sessionId="session-1" projectPath="D:/project/codeMUX" />
      </div>,
    );

    expect(document.querySelector('[data-file-id="App.tsx"]')).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId('outside-button'));

    expect(document.querySelector('[data-file-id="App.tsx"]')).toBeNull();
  });

  it('selects a suggestion with Enter without bubbling the key event to submit handlers', () => {
    composerText = '/rev';
    const bubbleSpy = vi.fn();

    render(
      <div onKeyDown={bubbleSpy}>
        <CodeMuxComposer sessionId="session-1" />
      </div>,
    );

    fireEvent.keyDown(screen.getByTestId('lexical-composer-input'), { key: 'Enter' });

    expect(setComposerTextMock).toHaveBeenCalledWith('[$review](review) ');
    expect(bubbleSpy).not.toHaveBeenCalled();
  });

  it('serializes a selected Codex skill with its complete path', () => {
    registerSkillCommands([{
      name: 'superpowers:brainstorming',
      description: 'Brainstorming',
      apps: { claude: true, codex: true, gemini: false, opencode: false },
      diskPath: 'C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming',
    }]);
    composerText = '/superpowers';

    render(<CodeMuxComposer sessionId="session-1" agentKind="codex" />);

    fireEvent.click(document.querySelector('[data-command-id="superpowers:brainstorming"]') as Element);

    expect(setComposerTextMock).toHaveBeenCalledWith('[$superpowers:brainstorming](C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming\\SKILL.md) ');
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

  it('renders a pending user question inside the composer and submits the selected option', () => {
    sendToolResponseMock.mockResolvedValue(undefined);
    useAgentStore.setState({ events: { 'session-1': pendingQuestionEvents } });

    render(<CodeMuxComposer sessionId="session-1" />);

    expect(screen.getByText('允许读取 Codex 官方手册吗？')).toBeTruthy();
    expect(screen.getByText('继续读取文档。')).toBeTruthy();

    fireEvent.click(screen.getByText('是'));
    fireEvent.click(screen.getByText('提交'));

    expect(sendToolResponseMock).toHaveBeenCalledWith('session-1', 'question-1', ['是']);
  });

  it('restores the normal composer after a user question receives a tool result', () => {
    useAgentStore.setState({ events: { 'session-1': answeredQuestionEvents } });

    render(<CodeMuxComposer sessionId="session-1" placeholder="输入消息..." />);

    expect(screen.queryByText('允许读取 Codex 官方手册吗？')).toBeNull();
    expect(screen.getByText('输入消息...')).toBeTruthy();
  });

  it('does not restore an unanswered user question after a later user message', () => {
    useAgentStore.setState({
      events: {
        'session-1': [
          ...pendingQuestionEvents,
          { kind: 'user', data: { content: '继续执行后续任务' } },
        ],
      },
    });

    render(<CodeMuxComposer sessionId="session-1" placeholder="输入消息..." />);

    expect(screen.queryByText('允许读取 Codex 官方手册吗？')).toBeNull();
    expect(screen.getByText('输入消息...')).toBeTruthy();
  });

  it('finds the latest final proposed plan after a result event', () => {
    expect(findLatestPendingProposedPlan([
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-plan',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: '<proposed_plan>\n# 计划\n\n## Summary\n摘要\n</proposed_plan>',
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-plan',
          session_id: 'session-1',
          duration_ms: 1000,
          duration_api_ms: 1000,
          num_turns: 1,
          result: '',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ], new Set())).toMatchObject({
      title: '计划',
    });
  });

  it('renders proposed plan approval in the composer, switches to full access, then sends approval', async () => {
    updatePermissionsMock.mockResolvedValue(undefined);
    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '实现一个贪吃蛇程序' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-plan',
              session_id: 'session-1',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: '<proposed_plan>\n# 贪吃蛇浏览器小游戏\n\n## Summary\n做一个浏览器小游戏。\n</proposed_plan>',
                }],
              },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-plan',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 1000,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
    });

    render(<TooltipProvider><CodeMuxComposer sessionId="session-1" agentKind="codex" /></TooltipProvider>);

    expect(screen.getByText('实施此计划？')).toBeTruthy();

    fireEvent.click(screen.getByText('是，实施此计划'));
    fireEvent.click(screen.getByText('提交'));

    await vi.waitFor(() => {
      expect(updatePermissionsMock).toHaveBeenCalledWith(
        'session-1',
        { kind: 'codex', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccessEnabled: true },
        'off',
      );
      expect(setComposerTextMock).toHaveBeenCalledWith('是，实施此计划');
      expect(composerSendMock).toHaveBeenCalled();
    });

    expect(updatePermissionsMock.mock.invocationCallOrder[0]).toBeLessThan(setComposerTextMock.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it('keeps proposed plan approval visible and does not send when full access switch fails', async () => {
    updatePermissionsMock.mockRejectedValueOnce(new Error('permission failed'));
    useAgentStore.setState({
      events: {
        'session-1': [
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-plan',
              session_id: 'session-1',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: '<proposed_plan>\n# 计划\n\n## Summary\n摘要\n</proposed_plan>',
                }],
              },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-plan',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 1000,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
    });

    render(<TooltipProvider><CodeMuxComposer sessionId="session-1" agentKind="codex" /></TooltipProvider>);

    fireEvent.click(screen.getByText('提交'));

    await vi.waitFor(() => {
      expect(screen.getByText('权限切换失败，计划尚未发送。请稍后重试。')).toBeTruthy();
    });

    expect(screen.getByText('实施此计划？')).toBeTruthy();
    expect(setComposerTextMock).not.toHaveBeenCalledWith('是，实施此计划');
    expect(composerSendMock).not.toHaveBeenCalled();
  });

  it('submits proposed plan adjustment text as a user message without switching permissions', () => {
    useAgentStore.setState({
      events: {
        'session-1': [
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-plan',
              session_id: 'session-1',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: '<proposed_plan>\n# 计划\n\n## Summary\n摘要\n</proposed_plan>',
                }],
              },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-plan',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 1000,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
    });

    render(<TooltipProvider><CodeMuxComposer sessionId="session-1" /></TooltipProvider>);

    fireEvent.click(screen.getByText('否，请告知 Codex 如何调整'));
    fireEvent.change(screen.getByPlaceholderText('告诉 Codex 需要怎样调整计划...'), {
      target: { value: '请加上移动端适配' },
    });
    fireEvent.click(screen.getByText('提交'));

    expect(setComposerTextMock).toHaveBeenCalledWith('请加上移动端适配');
    expect(composerSendMock).toHaveBeenCalled();
    expect(updatePermissionsMock).not.toHaveBeenCalled();
  });

  it('prioritizes pending user questions over proposed plan approval', () => {
    useAgentStore.setState({
      events: {
        'session-1': [
          ...pendingQuestionEvents,
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-plan',
              session_id: 'session-1',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: '<proposed_plan>\n# 计划\n\n## Summary\n摘要\n</proposed_plan>',
                }],
              },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-plan',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 1000,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
    });

    render(<CodeMuxComposer sessionId="session-1" />);

    expect(screen.getByText('允许读取 Codex 官方手册吗？')).toBeTruthy();
    expect(screen.queryByText('实施此计划？')).toBeNull();
  });

  it('does not render expired user questions in the composer', () => {
    useAgentStore.setState({
      events: {
        'session-1': [
          ...pendingQuestionEvents,
          {
            kind: 'ask_user_question_timeout',
            data: {
              tool_use_id: 'question-1',
              timeout_ms: 300000,
              message: '等待用户回复超时，请重新发送消息继续',
            },
          },
        ],
      },
    });

    render(<CodeMuxComposer sessionId="session-1" />);

    expect(screen.queryByText('允许读取 Codex 官方手册吗？')).toBeNull();
  });
});
