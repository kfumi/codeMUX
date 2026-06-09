// @vitest-environment jsdom

import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

type MockAgentState = {
  events: Record<string, unknown[]>;
  eventTimestamps: Record<string, number[]>;
  isRunning: Record<string, boolean>;
};

let mockAgentState: MockAgentState = {
  events: {},
  eventTimestamps: {},
  isRunning: {},
};

const { mockUseExternalStoreRuntime } = vi.hoisted(() => ({
  mockUseExternalStoreRuntime: vi.fn(() => ({ mocked: true })),
}));

vi.mock('@assistant-ui/react', () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useExternalStoreRuntime: mockUseExternalStoreRuntime,
}));

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: MockAgentState) => unknown) => selector(mockAgentState),
}));

import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';

describe('CodeMuxAssistantRuntimeProvider', () => {
  beforeEach(() => {
    mockAgentState = {
      events: { session: [] },
      eventTimestamps: { session: [] },
      isRunning: { session: true },
    };
    mockUseExternalStoreRuntime.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('passes the current session running state into the external runtime', () => {
    render(
      <CodeMuxAssistantRuntimeProvider
        sessionId="session"
        onSend={async () => {}}
        onCommand={async () => {}}
      >
        <div>child</div>
      </CodeMuxAssistantRuntimeProvider>,
    );

    expect(mockUseExternalStoreRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        isRunning: true,
      }),
    );
  });
});
