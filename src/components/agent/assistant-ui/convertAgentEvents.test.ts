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

  it('attaches ask-user-question results back to the original tool call when the tool event arrives later', () => {
    const events: AgentMessage[] = [
      {
        kind: 'ask_user_question',
        data: {
          tool_use_id: 'question-1',
          questions: [{
            question: '继续吗？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-question-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'question-1', content: '继续' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-question-tool',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'question-1',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    question: '继续吗？',
                    options: [{ label: '继续' }, { label: '取消' }],
                  }],
                },
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
        toolCallId: 'question-1',
        toolName: 'AskUserQuestion',
        args: {
          questions: [{
            question: '继续吗？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
        result: '继续',
        isError: false,
      },
    ]);
  });

  it('renders ask-user-question events as visible AskUserQuestion tool calls with submitted answers', () => {
    const events: AgentMessage[] = [
      {
        kind: 'user',
        data: { content: '帮我继续处理' },
      },
      {
        kind: 'ask_user_question',
        data: {
          tool_use_id: 'question-history-1',
          questions: [{
            question: '是否继续？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-question-history-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'question-history-1', content: '继续' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-final-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '好的，我继续。' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      id: 'ask_user_question-1',
      role: 'assistant',
      metadata: {
        sourceEventIndex: 1,
        sourceKind: 'ask_user_question',
      },
    });
    expect(messages[1]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'question-history-1',
        toolName: 'AskUserQuestion',
        args: {
          questions: [{
            question: '是否继续？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
        result: '继续',
        isError: false,
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

  it('ignores legacy subagent linkage fields on Agent tool_use blocks', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-agent-indexed',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-agent-indexed',
                name: 'Agent',
                input: { description: 'Read package.json', prompt: 'Read the file' },
                agentId: 'a6cae6d569918e2d3',
                subAgentKey: 'call-agent-indexed',
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages[0]?.content[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-agent-indexed',
      toolName: 'Agent',
      args: { description: 'Read package.json', prompt: 'Read the file' },
      result: undefined,
      isError: undefined,
    });
    expect(messages[0]?.content[0]).not.toHaveProperty('agentId');
    expect(messages[0]?.content[0]).not.toHaveProperty('subAgentKey');
  });

  it('hides Agent tool result metadata from the main tool result', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-agent-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-agent-1',
                name: 'Agent',
                input: { description: 'Read package.json', prompt: 'Read the file' },
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
          uuid: 'tool-result-agent-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-agent-1',
                content: [
                  { type: 'text', text: '项目名称：**codemux**，版本号：**1.0.0**' },
                  { type: 'text', text: "agentId: ae25c43324d205377 (use SendMessage with to: 'ae25c43324d205377' to continue this agent)\n<usage>subagent_tokens: 21236\ntool_uses: 1\nduration_ms: 4615</usage>" },
                ],
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
        toolCallId: 'call-agent-1',
        toolName: 'Agent',
        args: { description: 'Read package.json', prompt: 'Read the file' },
        result: '项目名称：**codemux**，版本号：**1.0.0**',
        isError: false,
      },
    ]);
  });

  it('hides Agent tool result metadata from string content', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-agent-2',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-agent-2',
                name: 'Agent',
                input: { prompt: 'do something' },
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
          uuid: 'tool-result-agent-2',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-agent-2',
                content: "result text\nagentId: abc123def (use SendMessage with to: 'abc123def' to continue this agent)",
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-agent-2',
      toolName: 'Agent',
      result: 'result text',
    });
    expect(messages[0]?.content[0]).not.toHaveProperty('agentId');
  });

  it('keeps metadata-like content in non-Agent tool results unchanged', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-bash',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-bash',
                name: 'Bash',
                input: { command: 'printf metadata' },
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
          uuid: 'tool-result-bash',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-bash',
                content: "result text\nagentId: abc123def\n<usage>tool output</usage>",
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages[0]?.content[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-bash',
      toolName: 'Bash',
      result: "result text\nagentId: abc123def\n<usage>tool output</usage>",
    });
  });

  it('renders only the compact marker for Claude compact turns', () => {
    const events: AgentMessage[] = [
      {
        kind: 'user',
        data: {
          content: 'This session is being continued from a previous conversation that ran out of context.',
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        } as any,
      },
      {
        kind: 'user',
        data: {
          content: '<local-command-stdout>Compacted</local-command-stdout>',
        },
      },
      {
        kind: 'compact',
        data: {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual', pre_tokens: 40956 },
        },
      },
      {
        kind: 'user',
        data: {
          content: '/compact',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: [{ type: 'data-codemux-event', eventKind: 'compact' }],
    });
  });

  it('does not render Claude task notification XML if it reaches the UI converter', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-before-meta',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'All finder angles are running in parallel.' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'user',
        data: {
          content: [
            '<task-notification>',
            '<status>completed</status>',
            '<summary>Agent completed</summary>',
            '</task-notification>',
          ].join('\n'),
          origin: { kind: 'task-notification' },
        } as any,
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toEqual([{ type: 'text', text: 'All finder angles are running in parallel.' }]);
  });

  it('renders only the compact marker when a Codex compact summary assistant message is present', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'summary-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Another language model started to solve this problem and produced a summary of its thinking process.',
              },
            ],
          },
          parent_tool_use_id: null,
        } as any,
      },
      {
        kind: 'compact',
        data: {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 0 },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: [{ type: 'data-codemux-event', eventKind: 'compact' }],
    });
  });

  it('does not mark an assistant before a compact marker as final for a later result', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-before-compact',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '压缩前的助手消息' }],
          },
          parent_tool_use_id: null,
        } as any,
      },
      {
        kind: 'compact',
        data: {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 237119 },
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-compact',
          session_id: 'session-1',
          duration_ms: 1,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: { input_tokens: 237119, output_tokens: 0 },
        } as any,
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.metadata.isFinalAssistantMessage).toBeUndefined();
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: [{ type: 'data-codemux-event', eventKind: 'compact' }],
    });
  });

});
