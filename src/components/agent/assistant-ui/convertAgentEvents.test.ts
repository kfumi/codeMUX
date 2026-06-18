import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../../stores/agentStore';
import { convertAgentEventsToAssistantMessages } from './convertAgentEvents';

describe('convertAgentEventsToAssistantMessages', () => {
  it('renders assistant narration before a pending tool call when live events arrive out of order', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__context7__resolve-library-id',
                input: { libraryName: 'Context7' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-text-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '让我再次尝试调用 Context7 工具：' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: '{"libraryId":"/upstash/context7"}',
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: '让我再次尝试调用 Context7 工具：' }]);
    expect(messages[1]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'mcp__context7__resolve-library-id',
        args: { libraryName: 'Context7' },
        result: '{"libraryId":"/upstash/context7"}',
        isError: false,
      },
    ]);
  });

  it('marks the latest unresolved tool call as failed when a sidecar error arrives', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
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

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'Command failed with exit code 1',
        isError: true,
      },
    ]);
  });

  it('marks the latest unresolved tool call as failed when an error result arrives', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'error',
          is_error: true,
          uuid: 'result-1',
          session_id: 'session-1',
          duration_ms: 42,
          duration_api_ms: 42,
          num_turns: 1,
          result: 'Bash exited with code 1',
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'Bash exited with code 1',
        isError: true,
      },
    ]);
  });

  it('attaches tool results that arrive before their matching live tool call', () => {
    const events: AgentMessage[] = [
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-query-docs',
                content: 'unsupported call',
                is_error: true,
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-query-docs',
                name: 'mcp__context7__query_docs',
                input: { libraryId: '/spring-projects/spring-boot' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-query-docs',
        toolName: 'mcp__context7__query_docs',
        args: { libraryId: '/spring-projects/spring-boot' },
        result: 'unsupported call',
        isError: true,
      },
    ]);
  });

  it('coalesces consecutive tool-only assistant events into one message for tool grouping', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: 'src/App.tsx' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-1',
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
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'Read',
                input: { file_path: 'src/main.tsx' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-2',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'main' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        args: { file_path: 'src/App.tsx' },
        result: 'app',
        isError: false,
      },
      {
        type: 'tool-call',
        toolCallId: 'tool-2',
        toolName: 'Read',
        args: { file_path: 'src/main.tsx' },
        result: 'main',
        isError: false,
      },
    ]);
  });

  it('marks trailing assistant text as final when the result event arrives before it', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'shell_command',
                input: { command: 'npm view mybatis version' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '3.5.19' }],
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
          uuid: 'result-1',
          session_id: 'session-1',
          duration_ms: 42,
          duration_api_ms: 42,
          num_turns: 1,
          result: '',
          total_cost_usd: 0,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
          },
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-text-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'MyBatis 最新版本是 3.5.19。' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.metadata.isFinalAssistantMessage).toBeUndefined();
    expect(messages[1]?.metadata.isFinalAssistantMessage).toBe(true);
  });
});
