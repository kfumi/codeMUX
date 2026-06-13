import { describe, expect, it } from 'vitest';
import { convertResponsesToChatRequest } from './codexRequestTransform.js';
import { CodexHistoryStore } from './codexHistory.js';
import { inferReasoningConfig } from './codexReasoning.js';

describe('convertResponsesToChatRequest', () => {
  const history = new CodexHistoryStore();

  it('converts basic user message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      stream: false,
    }, history, null);
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('injects instructions as system message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      instructions: 'You are helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      stream: false,
    }, history, null);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('converts function_call input to assistant tool_calls', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'content' },
      ],
      stream: false,
    }, history, null);
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp"}' },
      }],
    });
    expect(result.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'content',
    });
  });

  it('merges consecutive function_call items into one assistant message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
        { type: 'function_call', call_id: 'call_2', name: 'write_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a' },
        { type: 'function_call_output', call_id: 'call_2', output: 'b' },
      ],
      stream: false,
    }, history, null);
    expect(result.messages[0].tool_calls).toHaveLength(2);
  });

  it('injects stream_options when stream is true', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }, history, null);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it('does not inject stream_options when stream is false', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: false,
    }, history, null);
    expect(result.stream_options).toBeUndefined();
  });

  it('uses max_completion_tokens for o-series models', () => {
    const result = convertResponsesToChatRequest({
      model: 'o4-mini',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 1000,
      stream: false,
    }, history, null);
    expect(result.max_completion_tokens).toBe(1000);
    expect(result.max_tokens).toBeUndefined();
  });

  it('uses max_tokens for non-o-series models', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 1000,
      stream: false,
    }, history, null);
    expect(result.max_tokens).toBe(1000);
    expect(result.max_completion_tokens).toBeUndefined();
  });

  it('converts tool_choice object format', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'function', name: 'read_file' },
      stream: false,
    }, history, null);
    expect(result.tool_choice).toEqual({
      type: 'function',
      function: { name: 'read_file' },
    });
  });

  it('passes through string tool_choice as-is', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'auto',
      stream: false,
    }, history, null);
    expect(result.tool_choice).toBe('auto');
  });

  it('injects reasoning options for MiMo model', () => {
    const config = inferReasoningConfig('mimo-v2.5-pro', '', '');
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }, history, config);
    expect(result.thinking).toEqual({ type: 'enabled' });
  });

  it('converts tools from Responses format to Chat format', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      stream: false,
    }, history, null);
    expect(result.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
  });

  it('expands namespace tools and drops non-function tools unsupported by chat completions', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'namespace',
          name: 'mcp__chrome_devtools_mcp',
          tools: [
            {
              type: 'function',
              name: 'click',
              description: 'Click element',
              parameters: { type: 'object', properties: { uid: { type: 'string' } } },
            },
          ],
        },
        {
          type: 'web_search',
          external_web_access: true,
        },
        {
          type: 'function',
          name: 'shell_command',
          description: 'Run shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ] as any,
      stream: false,
    }, history, null);

    expect(result.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'mcp__chrome_devtools_mcp__click',
          description: 'Click element',
          parameters: { type: 'object', properties: { uid: { type: 'string' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'shell_command',
          description: 'Run shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ]);
  });
});
