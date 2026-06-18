import { describe, expect, it } from 'vitest';

import {
  CodexChatHistory,
  buildResponsesSseEvents,
  convertChatCompletionToResponses,
  convertResponsesToChatRequest,
} from './codexChatCompat.js';

describe('convertResponsesToChatRequest', () => {
  it('restores tool call history before appending tool outputs', () => {
    const history = new CodexChatHistory(8);
    history.store('resp_prev', [
      {
        role: 'user',
        content: 'List the current files',
      },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'shell',
              arguments: '{"command":["pwd"]}',
            },
          },
        ],
      },
    ]);

    const request = convertResponsesToChatRequest(
      {
        model: 'mimo-v2-pro',
        previous_response_id: 'resp_prev',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_123',
            output: 'D:/project/ai-code/codeMUX',
          },
        ],
        stream: true,
      },
      history,
    );

    expect(request).toMatchObject({
      model: 'mimo-v2-pro',
      stream: true,
      messages: [
        {
          role: 'user',
          content: 'List the current files',
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'shell',
                arguments: '{"command":["pwd"]}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: 'D:/project/ai-code/codeMUX',
        },
      ],
    });
  });
});

describe('convertChatCompletionToResponses', () => {
  it('extracts reasoning text and strips think tags from assistant content', () => {
    const history = new CodexChatHistory(8);

    const response = convertChatCompletionToResponses(
      {
        model: 'deepseek-v4-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'Plan the edit carefully',
              content: '<think>internal scratchpad</think>Applied the fix.',
              tool_calls: [
                {
                  id: 'call_456',
                  type: 'function',
                  function: {
                    name: 'shell',
                    arguments: '{"command":["git","status","--short"]}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      },
      {
        model: 'deepseek-v4-flash',
        input: [{ role: 'user', content: 'Inspect the workspace' }],
      },
      history,
    );

    expect(response.status).toBe('requires_action');
    expect(response.required_action).toMatchObject({
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [
          {
            id: 'call_456',
          },
        ],
      },
    });
    expect(response.output).toEqual([
      {
        type: 'reasoning',
        id: expect.any(String),
        summary: [
          {
            type: 'summary_text',
            text: 'Plan the edit carefully',
          },
        ],
      },
      {
        type: 'message',
        id: expect.any(String),
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Applied the fix.',
            annotations: [],
          },
        ],
      },
      {
        type: 'function_call',
        id: expect.any(String),
        call_id: 'call_456',
        name: 'shell',
        arguments: '{"command":["git","status","--short"]}',
      },
    ]);
    expect(response.output_text).toBe('Applied the fix.');
    expect(response.usage).toMatchObject({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 30,
    });
    expect(history.get(response.id)?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Applied the fix.',
      tool_calls: [
        {
          id: 'call_456',
        },
      ],
    });
  });

  it('unwraps MCP function names and preserves namespace metadata', () => {
    const history = new CodexChatHistory(8);

    const response = convertChatCompletionToResponses(
      {
        model: 'deepseek-v4-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_context7',
                  type: 'function',
                  function: {
                    name: 'mcp__context7__resolve_library_id',
                    arguments: '{"libraryName":"MyBatis"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      {
        model: 'deepseek-v4-flash',
        input: [{ role: 'user', content: 'Use Context7' }],
      },
      history,
    );

    expect(response.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_context7',
      name: 'resolve_library_id',
      namespace: 'mcp__context7',
      arguments: '{"libraryName":"MyBatis"}',
    });
  });
});

describe('buildResponsesSseEvents', () => {
  it('emits Codex-compatible SSE events for function calls and final completion', () => {
    const events = buildResponsesSseEvents({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'deepseek-v4-flash',
      status: 'requires_action',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_123',
          name: 'shell',
          arguments: '{"command":["pwd"]}',
        },
      ],
      usage: {
        input_tokens: 1,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: 2,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: 3,
      },
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      parallel_tool_calls: false,
      reasoning: null,
      text: {
        format: {
          type: 'text',
        },
      },
      tool_choice: 'auto',
      tools: [],
      truncation: 'disabled',
      metadata: {},
      output_text: '',
    });

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'requires_action',
      },
    });
  });

  it('preserves MCP namespace metadata in SSE function call items', () => {
    const events = buildResponsesSseEvents({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'deepseek-v4-flash',
      status: 'requires_action',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_context7',
          name: 'resolve_library_id',
          namespace: 'mcp__context7',
          arguments: '{"libraryName":"MyBatis"}',
        },
      ],
      usage: {
        input_tokens: 1,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: 2,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: 3,
      },
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      parallel_tool_calls: false,
      reasoning: null,
      text: {
        format: {
          type: 'text',
        },
      },
      tool_choice: 'auto',
      tools: [],
      truncation: 'disabled',
      metadata: {},
      output_text: '',
    });

    const itemDone = events.find((event) => event.type === 'response.output_item.done');

    expect(itemDone).toMatchObject({
      item: {
        type: 'function_call',
        name: 'resolve_library_id',
        namespace: 'mcp__context7',
      },
    });
  });
});
