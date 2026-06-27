// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { CodeMuxAssistantRuntimeProvider, resolveSlashCommand } from './CodeMuxAssistantRuntime';
import { CodeMuxThread, buildToolDurationMap } from './CodeMuxThread';

const sessionOneEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session one user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session one assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const sessionTwoEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session two user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-2',
      session_id: 'session-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session two assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const failedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-tool',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'error',
    data: {
      type: 'sidecar_error',
      error: 'Command failed with exit code 1',
    },
  },
];

const timestampOnlyAssistantEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-timestamp-only',
      session_id: 'session-timestamp',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'timestamp only assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const reasoningEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-reasoning',
      session_id: 'session-reasoning',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'thinking through it' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const groupedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'app' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'src/main.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'main' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const directiveUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '/review @src/App.tsx please check this' } },
];

const longUserText = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');

const longUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: longUserText } },
];

const originalScrollTo = HTMLElement.prototype.scrollTo;

function Harness({ sessionId }: { sessionId: string }) {
  return (
    <CodeMuxAssistantRuntimeProvider
      sessionId={sessionId}
      onSend={vi.fn(async () => {})}
      onCommand={vi.fn(async () => {})}
    >
      <CodeMuxThread sessionId={sessionId} />
    </CodeMuxAssistantRuntimeProvider>
  );
}

describe('CodeMuxAssistantRuntimeProvider', () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });

    useAgentStore.setState({
      events: {
        'session-1': sessionOneEvents,
        'session-2': sessionTwoEvents,
        'session-tool': failedToolEvents,
        'session-timestamp': timestampOnlyAssistantEvents,
        'session-reasoning': reasoningEvents,
        'session-grouped-tools': groupedToolEvents,
        'session-directives': directiveUserEvents,
        'session-long-user': longUserEvents,
      },
      eventTimestamps: {
        'session-1': [1, 2],
        'session-2': [3, 4],
        'session-tool': [5, 6],
        'session-timestamp': [Date.parse('2026-06-12T21:40:00+08:00')],
      },
      isRunning: {},
      error: {},
      mcpRuntimeStatus: {},
      todos: {},
      streamingThinking: {},
      streamingText: {},
      forceStopped: {},
      streamingToolInputs: {},
      streamingToolMeta: {},
      streamingToolIndexMap: {},
      streamedToolUseIds: {},
      changedFiles: {},
      fileOriginals: {},
      gitBaselines: {},
      acknowledgedFiles: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: originalScrollTo,
    });
    cleanup();
  });

  it('switches rendered messages when the active session changes', async () => {
    const view = render(<Harness sessionId="session-1" />);

    expect(await screen.findByText('session one assistant')).toBeTruthy();
    expect(screen.queryByText('session two assistant')).toBeNull();

    view.rerender(<Harness sessionId="session-2" />);

    expect(await screen.findByText('session two assistant')).toBeTruthy();
    expect(screen.queryByText('session one assistant')).toBeNull();
  });

  it('renders failed tool calls as errors instead of leaving them running', () => {
    const { container } = render(<Harness sessionId="session-tool" />);

    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.queryByText(/Error: Command failed with exit code 1/)).toBeNull();

    const trigger = container.querySelector('[data-slot="tool-group-trigger"]');
    if (trigger) fireEvent.click(trigger);

    expect(container.querySelector('.lucide-circle-x')).toBeTruthy();
    expect(container.querySelector('.lucide-loader')).toBeNull();
  });

  it('hides footer (copy button + timestamp) on intermediate or incomplete assistant messages', () => {
    render(<Harness sessionId="session-timestamp" />);

    expect(screen.getByText('timestamp only assistant')).toBeTruthy();
    // No result event means no isFinalAssistantMessage, so footer (timestamp) should not render.
    expect(screen.queryByText('21:40')).toBeNull();
  });

  it('renders the reasoning trigger like the native assistant-ui component', () => {
    const { container } = render(<Harness sessionId="session-reasoning" />);
    const trigger = container.querySelector('[data-slot="reasoning-trigger"]');
    const childSlots = Array.from(trigger?.children ?? []).map((element) =>
      element.getAttribute('data-slot'),
    );

    expect(childSlots).toEqual([
      'reasoning-trigger-icon',
      'reasoning-trigger-label',
      'reasoning-trigger-chevron',
    ]);
  });

  it('renders consecutive related tool calls inside one tool group', () => {
    const { container } = render(<Harness sessionId="session-grouped-tools" />);
    const toolGroup = container.querySelector('[data-slot="tool-group-root"]');

    expect(toolGroup).toBeTruthy();
    expect(toolGroup?.getAttribute('data-variant')).toBe('ghost');
    expect(container.querySelector('[data-slot="tool-group-trigger"]')).toBeTruthy();
  });

  it('does not resolve Claude-only slash commands in Codex sessions', () => {
    expect(resolveSlashCommand('/security-review', 'codex')).toBeNull();
    expect(resolveSlashCommand('/permissions', 'codex')).toBeNull();
    expect(resolveSlashCommand('/plan add tests', 'codex')).toMatchObject({
      command: expect.objectContaining({ name: 'plan' }),
      args: 'add tests',
    });
    expect(resolveSlashCommand('/security-review', 'claude_code')?.command.name).toBe('security-review');
  });

  it('renders directive text in user messages as chips', () => {
    const { container } = render(<Harness sessionId="session-directives" />);

    expect(screen.getByText('/review').closest('[data-directive-type="command"]')).toBeTruthy();
    expect(screen.getByText('App.tsx').closest('[data-directive-type="file"]')).toBeTruthy();
    expect(screen.getByText('please check this')).toBeTruthy();
    // Now file chips have a leading icon
    expect(container.querySelector('[data-directive-value="@src/App.tsx"] svg')).toBeTruthy();
  });

  it('keeps short streaming thinking complete but renders only the latest window for very long thinking', () => {
    const shortThinking = 'short thinking stays fully visible';
    const longThinkingHead = 'long-thinking-head';
    const longThinkingTail = 'long-thinking-tail';
    const longThinking = `${longThinkingHead}${'x'.repeat(21_000)}${longThinkingTail}`;

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-short': true, 'session-stream-long': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-short': Date.now(), 'session-stream-long': Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        'session-stream-short': shortThinking,
        'session-stream-long': longThinking,
      },
    }));

    const view = render(<Harness sessionId="session-stream-short" />);
    fireEvent.click(view.container.querySelector('[data-slot="reasoning-trigger"]')!);

    expect(screen.getByText(shortThinking)).toBeTruthy();

    view.unmount();
    const longView = render(<Harness sessionId="session-stream-long" />);
    fireEvent.click(longView.container.querySelector('[data-slot="reasoning-trigger"]')!);

    expect(longView.container.textContent).not.toContain(longThinkingHead);
    expect(screen.getByText(new RegExp(`${longThinkingTail}$`))).toBeTruthy();
  });

  it('renders live streaming text with markdown parsing using Streamdown', () => {
    const streamingText = '**streaming bold**\n\n```ts\nconst value = 1;\n```';

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-text': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-text': Date.now() },
      streamingText: {
        ...state.streamingText,
        'session-stream-text': streamingText,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-text" />);

    // Now uses Streamdown for real-time markdown rendering
    expect(container.querySelector('[data-streaming-text="markdown"]')).toBeTruthy();
    expect(container.querySelector('.aui-md')).toBeTruthy();
  });

  it('collapses very long user messages behind a show-more control', () => {
    const { container } = render(<Harness sessionId="session-long-user" />);

    expect(screen.getByText(/line 80/)).toBeTruthy();
    const userMessageRoot = container.querySelector('[data-message-id="user-0"]');
    const bubbleColumn = userMessageRoot?.querySelector('[data-user-message-column="true"]');
    const bubble = userMessageRoot?.querySelector('[data-user-message-bubble="true"]');

    expect(bubbleColumn?.className).toContain('max-w-10/12');
    expect(bubbleColumn?.className).not.toContain('max-w-[78%]');
    expect(bubble?.className).toContain('max-h-80');
    expect(bubble?.className).toContain('overflow-hidden');
    expect(bubble?.className).not.toContain('overflow-y-auto');

    const showMore = screen.getByRole('button', { name: '查看更多' });
    fireEvent.click(showMore);

    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy();
    expect(bubble?.className).not.toContain('max-h-80');
  });

  it('returns tool durations from event-reported data only', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-repeat',
          session_id: 'session-tool-repeat',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-repeat', name: 'mcp__context7__query_docs', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-first',
          session_id: 'session-tool-repeat',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-repeat', content: 'first' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'raw',
        data: {
          type: 'tool_progress',
          tool_use_id: 'call-repeat',
          elapsed_time_seconds: 0.25,
        },
      },
    ];

    // Now uses event-reported durations only
    expect(buildToolDurationMap(events)).toEqual({
      'call-repeat': 250,
    });
  });

  it('returns empty durations when no tool_progress or task_notification events', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-no-progress',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    // No event-reported durations, so returns empty
    expect(buildToolDurationMap(events)).toEqual({});
  });
});
