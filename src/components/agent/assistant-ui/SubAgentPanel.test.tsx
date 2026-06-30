// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubAgentPanel } from './SubAgentPanel';

const loadSubagentEventsMock = vi.fn();

type MockAgentStoreState = {
  subAgentEvents: Record<string, unknown[] | undefined>;
  subAgentLoading: Record<string, boolean | undefined>;
  loadSubagentEvents: typeof loadSubagentEventsMock;
};

let mockState: MockAgentStoreState;

vi.mock('@/components/ui/collapsible', () => {
  const React = require('react') as typeof import('react');
  const CollapsibleContext = React.createContext<{ open: boolean; onOpenChange: (open: boolean) => void } | null>(null);

  return {
    Collapsible: ({ open, onOpenChange, className, children }: any) => (
      <CollapsibleContext.Provider value={{ open, onOpenChange }}>
        <div className={className}>{children}</div>
      </CollapsibleContext.Provider>
    ),
    CollapsibleTrigger: ({ children, ...props }: any) => {
      const context = React.useContext(CollapsibleContext);
      return (
        <button
          type="button"
          {...props}
          onClick={() => context?.onOpenChange(!context.open)}
        >
          {children}
        </button>
      );
    },
    CollapsibleContent: ({ children, ...props }: any) => {
      const context = React.useContext(CollapsibleContext);
      return context?.open ? <div {...props}>{children}</div> : null;
    },
  };
});

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: MockAgentStoreState) => unknown) => selector(mockState),
}));

vi.mock('./convertAgentEvents', () => ({
  convertAgentEventsToAssistantMessages: () => [],
}));

describe('SubAgentPanel', () => {
  beforeEach(() => {
    mockState = {
      subAgentEvents: {},
      subAgentLoading: {},
      loadSubagentEvents: loadSubagentEventsMock,
    };
    loadSubagentEventsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads history by agent id even when live subagent cache already exists', async () => {
    mockState.subAgentEvents = {
      'session-1:call_live_agent': [
        { kind: 'assistant' },
      ],
    };

    render(
      <SubAgentPanel
        subAgentKey="call_live_agent"
        historyAgentId="alive123"
        sessionId="session-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子智能体/i }));

    await waitFor(() => {
      expect(loadSubagentEventsMock).toHaveBeenCalledWith('session-1', 'alive123');
    });
  });
});
