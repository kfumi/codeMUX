// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxThread } from './CodeMuxThread';

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

    useAgentStore.setState({
      events: {
        'session-1': sessionOneEvents,
        'session-2': sessionTwoEvents,
      },
      eventTimestamps: {
        'session-1': [1, 2],
        'session-2': [3, 4],
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
    cleanup();
  });

  it('switches rendered messages when the active session changes', () => {
    const view = render(<Harness sessionId="session-1" />);

    expect(screen.getByText('session one assistant')).toBeTruthy();
    expect(screen.queryByText('session two assistant')).toBeNull();

    view.rerender(<Harness sessionId="session-2" />);

    expect(screen.getByText('session two assistant')).toBeTruthy();
    expect(screen.queryByText('session one assistant')).toBeNull();
  });
});
