import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../../stores/agentStore';
import { convertAgentEventsToAssistantMessages } from './convertAgentEvents';

import { buildActivityRuns } from '../../../lib/activityRuns';
import { buildConversationTurns } from '../../../lib/conversationTurns';

/**
 * 这些事件在渲染侧被分成几段（处理段）——「相邻工具仍属同一个工具组」这条契约现在由
 * 分段保证：转换器不再把相邻工具卡合并进同一条消息，而是各自一行。
 */
function activityRunCount(events: AgentMessage[]): number {
  const timestamps = events.map((_, index) => (index + 1) * 1000);
  const turns = buildConversationTurns(events, { isRunning: true, timestamps });
  return buildActivityRuns(events, turns, timestamps, { isRunning: true }).runs.length;
}

describe('convertAgentEventsToAssistantMessages', () => {
  it('merges repeated tool_started projections into one card with refreshed args', () => {
    // OpenCode tool parts arrive with empty input at `pending`; the real
    // arguments stream in with the `running`/`completed` update.
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'tool-start-empty',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: {} }] },
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'tool-start-full',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { file_path: 'D:/demo/package.json' } }] },
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
              { type: 'tool_result', tool_use_id: 'call-1', content: 'file body' },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    const toolCards = messages.flatMap((message) => message.content.filter(
      (part) => part.type === 'tool-call' && part.toolCallId === 'call-1',
    ));
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'read',
      args: { file_path: 'D:/demo/package.json' },
      result: 'file body',
    });
  });

  it('ignores ephemeral live-stream narration placeholders during conversion', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: 'hello' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'live-stream-narration:session-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-final',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'done' },
              { type: 'text', text: 'partial answer' },
            ],
          },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const assistantMessages = messages.filter((message) => message.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      { type: 'reasoning', text: 'done' },
      { type: 'text', text: 'partial answer' },
    ]);
  });

  it('renders an OpenCode assistant text event before its terminal result', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: 'hello' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'opencode-assistant-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OpenCode reply' }] },
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'opencode-result-1',
          session_id: 'session-1',
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'OpenCode reply' }],
      metadata: { isFinalAssistantMessage: true },
    });
  });

  it('collapses repeated api retry events into one visible status message', () => {
    const events: AgentMessage[] = [
      {
        kind: 'api_retry',
        data: {
          type: 'system',
          subtype: 'api_retry',
          attempt: 7,
          max_retries: 10,
          retry_delay_ms: 1000,
          error_status: 429,
          error: 'rate_limit',
        },
      },
      {
        kind: 'api_retry',
        data: {
          type: 'system',
          subtype: 'api_retry',
          attempt: 8,
          max_retries: 10,
          retry_delay_ms: 1000,
          error_status: 429,
          error: 'rate_limit',
        },
      },
      {
        kind: 'api_retry',
        data: {
          type: 'system',
          subtype: 'api_retry',
          attempt: 10,
          max_retries: 10,
          retry_delay_ms: 0,
          error_status: 429,
          error: 'rate_limit',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'system',
      metadata: {
        sourceEventIndex: 2,
        sourceEventIndices: [0, 1, 2],
      },
    });
    expect(messages[0]?.content[0]).toMatchObject({
      type: 'data-codemux-event',
      eventKind: 'api_retry',
      event: expect.objectContaining({
        data: expect.objectContaining({
          attempt: 10,
          max_retries: 10,
        }),
      }),
    });
  });

  it('copies user message locator into assistant-ui metadata', () => {
    const events: AgentMessage[] = [
      {
        kind: 'user',
        data: {
          content: 'use skill safely',
          locator: {
            providerMessageId: 'provider-user-1',
            lineIndex: 7,
            role: 'user',
            textFingerprint: 'use skill safely',
            turnOrdinal: 2,
          },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages[0]?.metadata.locator).toEqual({
      providerMessageId: 'provider-user-1',
      lineIndex: 7,
      role: 'user',
      textFingerprint: 'use skill safely',
      turnOrdinal: 2,
    });
  });

  it('does not crash on error or result events with missing text fields', () => {
    const events: AgentMessage[] = [
      {
        kind: 'error',
        data: { type: 'sidecar_error' } as AgentMessage['data'],
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'error',
          is_error: true,
          uuid: 'result-1',
          session_id: 'session-1',
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: undefined as unknown as string,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ];

    expect(() => convertAgentEventsToAssistantMessages(events)).not.toThrow();
  });

  it('renders assistant narration before a pending tool call when events follow store timeline order', () => {
    const events: AgentMessage[] = [
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

  it('renders assistant narration before a finished tool when events follow store timeline order', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-text-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '先看两个页面的现状——' }],
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
                id: 'tool-1',
                name: 'bash',
                input: { command: 'pwd' },
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
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'ok',
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: '先看两个页面的现状——' }]);
    expect(messages[1]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'pwd' },
        result: 'ok',
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

  it('marks ask-user-question timeout events as errored tool results', () => {
    const events: AgentMessage[] = [
      {
        kind: 'ask_user_question',
        data: {
          tool_use_id: 'question-timeout-1',
          questions: [{
            question: '是否继续？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
      },
      {
        kind: 'ask_user_question_timeout',
        data: {
          tool_use_id: 'question-timeout-1',
          timeout_ms: 300000,
          message: '等待用户回复超时，请重新发送消息继续',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'question-timeout-1',
        toolName: 'AskUserQuestion',
        args: {
          questions: [{
            question: '是否继续？',
            options: [{ label: '继续' }, { label: '取消' }],
          }],
        },
        result: '等待用户回复超时，请重新发送消息继续',
        isError: true,
      },
    ]);
  });

  it('keeps consecutive tool-only events as their own message rows', () => {
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

    // 相邻工具各自一行：一个步骤一个 `data-message-row`，不再合并进上一条消息。
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content)).toEqual([
      [
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          args: { file_path: 'src/App.tsx' },
          result: 'app',
          isError: false,
        },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'tool-2',
          toolName: 'Read',
          args: { file_path: 'src/main.tsx' },
          result: 'main',
          isError: false,
        },
      ],
    ]);
    // 行拆开了，分段不变：两次调用仍属同一个处理段。
    expect(activityRunCount(events)).toBe(1);
  });

  it('keeps reasoning separate from tool events between text messages', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-think-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '先看桌面端架构' }],
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
          uuid: 'assistant-think-2',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '再核对任务入口' }],
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
            content: [{ type: 'text', text: '架构已摸清。' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.content.map((part) => part.type))).toEqual([
      ['reasoning'],
      ['tool-call'],
      ['reasoning'],
      ['text'],
    ]);
    expect(messages[3]?.content).toEqual([{ type: 'text', text: '架构已摸清。' }]);
  });

  it('ignores whitespace-only text so tools stay in one process group', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-read-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-read-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-read-1', content: 'app' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-blank-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '\n\n' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-bash-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-bash-1', name: 'bash', input: { command: 'python repro.py' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-bash-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-bash-1', content: 'ok' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    // 空文本事件既不产出行也不切段：两个工具各自一行，仍属同一个处理段。
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content.map((part) => (
      part.type === 'tool-call' ? part.toolName : part.type
    )))).toEqual([['Read'], ['bash']]);
    expect(activityRunCount(events)).toBe(1);
  });

  it('keeps trailing thinking with the final answer text instead of merging into tools', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
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
          uuid: 'assistant-blank-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '\n\n' }],
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
            content: [
              { type: 'thinking', thinking: '先给结论。' },
              { type: 'text', text: '探活和 opencode 打的不是同一条路。' },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(messages[1]?.content.map((part) => part.type)).toEqual(['reasoning', 'text']);
  });

  it('keeps thinking separate from a later tool when narration arrives between them', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'opencode-thinking-message',
          session_id: 'session-1',
          opencode_session_id: 'opencode-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '先分析 SDK 接入方式' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'opencode-narration-message',
          session_id: 'session-1',
          opencode_session_id: 'opencode-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '我先从 SDK 源码开始。' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'opencode-tool-message',
          session_id: 'session-1',
          opencode_session_id: 'opencode-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'webfetch-1', name: 'WebFetch', input: { url: 'https://example.com' } }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages.map((message) => message.content.map((part) => part.type))).toEqual([
      ['reasoning'],
      ['text'],
      ['tool-call'],
    ]);
  });

  it('ignores whitespace-only text inside a mixed process event', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-mixed-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '先写脚本' },
              { type: 'text', text: '\n\n' },
              { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: 'repro.py' } },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.map((part) => part.type)).toEqual(['reasoning', 'tool-call']);
  });

  it('keeps write and edit tools as their own rows inside one tool group', () => {
    const mutationNames = ['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'];

    for (const name of mutationNames) {
      const events: AgentMessage[] = [
        {
          kind: 'assistant',
          data: {
            type: 'assistant',
            uuid: `assistant-read-${name}`,
            session_id: 'session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `read-${name}`, name: 'Read', input: { file_path: 'src/App.tsx' } }],
            },
            parent_tool_use_id: null,
          },
        },
        {
          kind: 'tool_result',
          data: {
            type: 'user',
            uuid: `result-read-${name}`,
            session_id: 'session-1',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: `read-${name}`, content: 'app' }],
            },
            parent_tool_use_id: null,
          },
        },
        {
          kind: 'assistant',
          data: {
            type: 'assistant',
            uuid: `assistant-mut-${name}`,
            session_id: 'session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `mut-${name}`, name, input: { file_path: 'src/App.tsx' } }],
            },
            parent_tool_use_id: null,
          },
        },
        {
          kind: 'tool_result',
          data: {
            type: 'user',
            uuid: `result-mut-${name}`,
            session_id: 'session-1',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: `mut-${name}`, content: 'ok' }],
            },
            parent_tool_use_id: null,
          },
        },
        {
          kind: 'assistant',
          data: {
            type: 'assistant',
            uuid: `assistant-bash-${name}`,
            session_id: 'session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `bash-${name}`, name: 'Bash', input: { command: 'pwd' } }],
            },
            parent_tool_use_id: null,
          },
        },
      ];

      const messages = convertAgentEventsToAssistantMessages(events);

      // 各自一行；「同一个工具组」由分段保证（原先靠合并消息）。
      expect(messages.map((message) => message.content.map((part) => (
        part.type === 'tool-call' ? part.toolName : part.type
      ))), name).toEqual([['Read'], [name], ['Bash']]);
      expect(activityRunCount(events), name).toBe(1);
    }
  });

  it('keeps Codex apply_patch shell commands as their own row inside one tool group', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-read-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-patch-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'tool-patch-1',
              name: 'shell_command',
              input: {
                command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/a.ts\n+export {}\n*** End Patch\nPATCH",
              },
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-bash-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-bash-1', name: 'Bash', input: { command: 'pwd' } }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages.map((message) => message.content.map((part) => (
      part.type === 'tool-call' ? part.toolName : part.type
    )))).toEqual([['Read'], ['shell_command'], ['Bash']]);
    expect(activityRunCount(events)).toBe(1);
  });

  it('keeps trailing thinking with the final answer text instead of peeling into tools', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
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
          uuid: 'assistant-final-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '架构已摸清。先给你我的分析，再确认几个关键决策点。' },
              { type: 'text', text: '现状关键事实' },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(messages[1]?.content.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(messages[1]?.content[0]).toEqual({
      type: 'reasoning',
      text: '架构已摸清。先给你我的分析，再确认几个关键决策点。',
    });
    expect(messages[1]?.content[1]).toEqual({ type: 'text', text: '现状关键事实' });
  });

  it('keeps the final footer on trailing text instead of merged thinking', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '定稿方案' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
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
          uuid: 'assistant-final-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '方案可以定稿了' },
              { type: 'text', text: '方案已定稿，汇总如下。' },
            ],
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
          duration_ms: 21_700,
          duration_api_ms: 21_700,
          num_turns: 1,
          result: '',
          usage: { input_tokens: 141, output_tokens: 629 },
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const assistantMessages = messages.filter((message) => message.role === 'assistant');

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(assistantMessages[0]?.metadata.isFinalAssistantMessage).toBeUndefined();
    expect(assistantMessages[1]?.content.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(assistantMessages[1]?.metadata.isFinalAssistantMessage).toBe(true);
  });

  it('keeps thinking in its own message when it arrives after a pending tool', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-think-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '先看桌面端架构' }],
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
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(messages[1]?.content.map((part) => part.type)).toEqual(['reasoning']);
  });

  it('keeps ask-user-question tools out of surrounding grouped tool messages', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-think-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '先读配置' }],
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
          uuid: 'assistant-ask-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [] } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'ask-result-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'ok' }],
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
            content: [{ type: 'tool_use', id: 'tool-2', name: 'Glob', input: { pattern: 'src/**/*.tsx' } }],
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
            content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'files' }],
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
            content: [{ type: 'text', text: '确认后再继续。' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(5);
    expect(messages[0]?.content.map((part) => part.type)).toEqual(['reasoning']);
    expect(messages[1]?.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(messages[2]?.content).toEqual([
      expect.objectContaining({ type: 'tool-call', toolName: 'AskUserQuestion', toolCallId: 'ask-1' }),
    ]);
    expect(messages[3]?.content).toEqual([
      expect.objectContaining({ type: 'tool-call', toolName: 'Glob', toolCallId: 'tool-2' }),
    ]);
    expect(messages[4]?.content).toEqual([{ type: 'text', text: '确认后再继续。' }]);
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

  it('collapses duplicate tool calls with the same id inside one assistant event into one merged card', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-dup-in-event',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-dup',
                name: 'Bash',
                input: { command: 'echo first' },
              },
              {
                type: 'tool_use',
                id: 'call-dup',
                name: 'Bash',
                input: { command: 'echo second' },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    expect(messages[0]?.content[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-dup',
      // A later projection of the same tool call refreshes its args in place.
      args: { command: 'echo second' },
    });
  });

  it('drops duplicate tool calls replayed across consecutive assistant events', () => {
    const toolUseEvent = (uuid: string): AgentMessage => ({
      kind: 'assistant',
      data: {
        type: 'assistant',
        uuid,
        session_id: 'session-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-replayed',
              name: 'Read',
              input: { path: 'package.json' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
    });

    const messages = convertAgentEventsToAssistantMessages([
      toolUseEvent('assistant-replay-original'),
      toolUseEvent('assistant-replay-duplicate'),
    ]);

    const toolCalls = messages.flatMap((message) =>
      message.content.filter((part) => part.type === 'tool-call'),
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'call-replayed' });
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

  it('renders session_summary events as data-codemux-event parts', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: 'hello' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [
            { file: 'src/foo.ts', additions: 3, deletions: 1, status: 'modified' },
          ],
          uuid: 'summary-1',
          session_id: 'session-1',
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
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);

    // Session summary should be attached as a footer on the last assistant
    // message instead of rendered as a standalone system message.
    const summaryMessage = messages.find(
      (m) => m.metadata.sourceKind === 'session_summary',
    );
    expect(summaryMessage).toBeUndefined();

    const assistantMessage = messages.find((m) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.content).toHaveLength(2);
    expect(assistantMessage?.content[0]).toMatchObject({ type: 'text', text: 'done' });
    expect(assistantMessage?.content[1]).toMatchObject({
      type: 'data-codemux-event',
      eventKind: 'session_summary',
    });
  });

  it('attaches session_summary to interrupted turns', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: 'modify file' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial work' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'src/app.ts', additions: 2, deletions: 0 }],
          uuid: 'summary-interrupted-1',
          session_id: 'session-1',
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'interrupted',
          is_error: true,
          uuid: 'result-interrupted-1',
          session_id: 'session-1',
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: 'Interrupted by user',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const assistantMessage = messages.find((message) => message.role === 'assistant');
    expect(assistantMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'data-codemux-event', eventKind: 'session_summary' }),
    ]));
  });

  it('does not render a summary while the turn is still running', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '请修改文件' } },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'index.html', additions: 1, deletions: 1, status: 'modified' }],
          uuid: 'summary-running-1',
          session_id: 'session-1',
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-thinking-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Done. The edit was applied successfully.' }] },
          parent_tool_use_id: null,
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const summaryParts = messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');

    expect(summaryParts).toHaveLength(0);
  });

  it('defers a summary that arrives after a tool until the final assistant message', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '请修改文件' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'edit', input: { filePath: 'index.html' } }],
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
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Edit applied successfully.' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'index.html', additions: 1, deletions: 1, status: 'modified' }],
          uuid: 'summary-1',
          session_id: 'session-1',
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-final-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: '已完成修改。' }] },
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
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const toolMessage = messages.find((message) => message.content.some((part) => part.type === 'tool-call'));
    const finalMessage = messages.find((message) => (
      message.role === 'assistant' && message.content.some((part) => part.type === 'text')
    ));

    expect(toolMessage?.content).toHaveLength(1);
    expect(finalMessage?.content.filter((part) => part.type === 'data-codemux-event')).toHaveLength(1);
    expect(finalMessage?.content.at(-1)).toMatchObject({
      type: 'data-codemux-event',
      eventKind: 'session_summary',
    });
  });

  it('renders session_summary for the exact claude live timeline shape (tool kind split + file_snapshot)', () => {
    // 生产时间线实测形状（seq 41-47）：claude 实时把工具事件拆成独立事件，
    // Edit 之前还有 file_snapshot。summary 夹在最终 assistant 与 result 之间。
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '把文件改一下' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'evt-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_edit', name: 'Edit', input: { file_path: 'D:/x/a.ts', old_string: 'a', new_string: 'b' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'file_snapshot',
        data: { type: 'file_snapshot', file_path: 'D:/x/a.ts', original_content: 'a', is_new: false, tool_use_id: 'call_edit' },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'evt-fin-1',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_edit', content: 'ok', is_error: false }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'evt-asst-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: '已完成修改。' }] },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'D:/x/a.ts', before: 'a', after: 'b', additions: 1, deletions: 1 }],
          uuid: 'evt-summary-1',
          session_id: 'session-1',
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'evt-result-1',
          session_id: 'session-1',
          duration_ms: 10000,
          duration_api_ms: 9000,
          num_turns: 1,
          result: '',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const parts = messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');
    expect(parts).toHaveLength(1);
  });

  it('attaches session_summary to trailing text instead of the peeled process group', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '将About页面的Ztwo改为Ztwo123' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'edit', input: { filePath: 'index.html' } }],
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
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Edit applied successfully.' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'index.html', additions: 1, deletions: 1, status: 'modified' }],
          uuid: 'summary-1',
          session_id: 'session-1',
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
            content: [
              { type: 'thinking', thinking: '改完 About 文案就可以收尾了。' },
              { type: 'text', text: '已完成。About 页面中的 Ztwo 已改为 Ztwo123。' },
            ],
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
          duration_ms: 6000,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const processMessage = messages.find((message) => (
      message.role === 'assistant' && message.content.some((part) => part.type === 'tool-call')
    ));
    const textMessage = messages.find((message) => (
      message.role === 'assistant' && message.content.some((part) => part.type === 'text')
    ));

    expect(processMessage?.content.some((part) => part.type === 'data-codemux-event')).toBe(false);
    expect(textMessage?.content.at(-1)).toMatchObject({
      type: 'data-codemux-event',
      eventKind: 'session_summary',
    });
    expect(textMessage?.metadata.isFinalAssistantMessage).toBe(true);
  });

  it('coalesces repeated summaries into one final summary card per turn', () => {
    const summary = (uuid: string, file: string): AgentMessage => ({
      kind: 'session_summary',
      data: {
        type: 'system',
        subtype: 'session_summary',
        diffs: [{ file, additions: 1, deletions: 0, status: 'modified' }],
        uuid,
        session_id: 'session-1',
      },
    });
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '请修改文件' } },
      summary('summary-1', 'index.html'),
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-final-1',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: '已完成修改。' }] },
          parent_tool_use_id: null,
        },
      },
      summary('summary-2', 'index.html'),
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-1',
          session_id: 'session-1',
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
        },
      },
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const summaryParts = messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');

    expect(summaryParts).toHaveLength(1);
    expect(messages.find((message) => message.role === 'system')).toBeUndefined();
  });

  it('pins one artifact card per turn, attached to that turn final assistant message', () => {
    const summary = (
      uuid: string,
      diffs: Array<{ file: string; additions: number; deletions: number; status: string }>,
    ): AgentMessage => ({
      kind: 'session_summary',
      data: {
        type: 'system',
        subtype: 'session_summary',
        diffs,
        uuid,
        session_id: 'session-1',
      },
    });
    const assistant = (uuid: string, text: string): AgentMessage => ({
      kind: 'assistant',
      data: {
        type: 'assistant',
        uuid,
        session_id: 'session-1',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      },
    });
    const result = (uuid: string): AgentMessage => ({
      kind: 'result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid,
        session_id: 'session-1',
        duration_ms: 10,
        duration_api_ms: 10,
        num_turns: 1,
        result: '',
      },
    });

    // 第 1 轮：运行时为同一个提问收了三次尾（生产库里见过 6 次），
    // 同一文件先改后改，最终统计必须取整轮净变化 —— 三次收尾里最后一次的结果。
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '请修改文件' } },
      assistant('assistant-r1-a', '先看一下现状。'),
      summary('summary-r1-1', [{ file: 'index.html', additions: 1, deletions: 0, status: 'modified' }]),
      assistant('assistant-r1-final', '已完成修改。'),
      summary('summary-r1-2', [
        { file: 'index.html', additions: 5, deletions: 2, status: 'modified' },
      ]),
      summary('summary-r1-3', [
        {
          file: 'index.html',
          additions: 9,
          deletions: 4,
          status: 'modified',
          before: 'a\nb\nc',
          after: 'a\nB\nc\nd',
        },
      ]),
      result('result-r1'),
      { kind: 'user', data: { content: '再改一个文件' } },
      assistant('assistant-r2-final', '第二个文件也改好了。'),
      summary('summary-r2-1', [{ file: 'other.ts', additions: 2, deletions: 1, status: 'modified' }]),
      result('result-r2'),
    ];

    const messages = convertAgentEventsToAssistantMessages(events);
    const carriers = messages.filter((message) =>
      message.content.some(
        (part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary',
      ),
    );

    // 一轮一张卡，整条会话只有两张，且各自挂在该轮最后一条助手消息上。
    expect(carriers).toHaveLength(2);
    expect(carriers.map((message) => message.metadata.sourceUuid)).toEqual([
      'assistant-r1-final',
      'assistant-r2-final',
    ]);

    // 卡片内容是整轮净变化：同文件在整轮内被改多次时取最后一次成功结果。
    const diffsOf = (message: (typeof carriers)[number]) => {
      const part = message.content.find(
        (candidate) =>
          candidate.type === 'data-codemux-event' && candidate.eventKind === 'session_summary',
      );
      return (part as { event: { data: { diffs: Array<{ file: string }> } } }).event.data.diffs;
    };
    expect(diffsOf(carriers[0]).map((diff) => diff.file)).toEqual(['index.html']);
    expect(diffsOf(carriers[0])[0]).toMatchObject({ additions: 9, deletions: 4 });
    expect(diffsOf(carriers[1]).map((diff) => diff.file)).toEqual(['other.ts']);
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
