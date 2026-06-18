// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
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

    expect(screen.getByText(/工具/i)).toBeTruthy();
    expect(screen.queryByText(/Error: Command failed with exit code 1/)).toBeNull();

    // Single tool call is now wrapped in a collapsed ToolGroup — expand it to check the icon
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
    expect(screen.getByText('2 次工具调用')).toBeTruthy();
  });

  it('keeps the first completion time when duplicate live tool results arrive', () => {
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
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-duplicate',
          session_id: 'session-tool-repeat',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-repeat', content: 'duplicate' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    expect(buildToolDurationMap(events, [1_000, 1_250, 5_000])).toEqual({
      'call-repeat': 250,
    });
  });
});
