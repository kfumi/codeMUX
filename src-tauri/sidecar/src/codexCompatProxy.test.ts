import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';

import { createCodexCompatProxyServer } from './codexCompatProxy.js';
import { clearActivePermissionState } from './activePermissionState.js';

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Server did not expose a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
let stdoutSpy: ReturnType<typeof vi.spyOn> | null = null;
let stdoutWrites: string[] = [];

beforeEach(() => {
  clearActivePermissionState();
  stdoutWrites = [];
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
});

afterEach(async () => {
  clearActivePermissionState();
  stdoutSpy?.mockRestore();
  stdoutSpy = null;
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('createCodexCompatProxyServer (protocol translation only)', () => {
  it('forwards model-list requests to upstream compatible endpoints', async () => {
    const upstream = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/models');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [
          {
            id: 'mimo-v2-pro',
            owned_by: 'xiaomi',
          },
        ],
      }));
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'proxy-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/models`);
    const json = await response.json();

    expect(json).toEqual({
      data: [
        {
          id: 'mimo-v2-pro',
          owned_by: 'xiaomi',
        },
      ],
    });
  });

  it('responds to local health checks without touching the upstream provider', async () => {
    let upstreamTouched = false;
    const upstream = createServer((_req, _res) => {
      upstreamTouched = true;
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'proxy-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/__codemux_proxy_health`);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true });
    expect(typeof json.configFingerprint).toBe('string');
    expect(upstreamTouched).toBe(false);
  });

  it('translates responses requests into chat completions and preserves tool-call history without emitting timeline events', async () => {
    const upstreamBodies: unknown[] = [];
    let firstTurn = true;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.setHeader('content-type', 'application/json');

      if (firstTurn) {
        firstTurn = false;
        res.end(JSON.stringify({
          model: 'deepseek-v4-flash',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
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
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 7,
            total_tokens: 12,
          },
        }));
        return;
      }

      res.end(JSON.stringify({
        model: 'deepseek-v4-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'All set.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 8,
          total_tokens: 14,
        },
      }));
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'proxy-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    cleanups.push(() => proxy.close());

    const firstResponse = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: [{ role: 'user', content: 'Show me the working directory' }],
      }),
    });
    const firstJson = await firstResponse.json();

    expect(firstJson.status).toBe('requires_action');
    expect(upstreamBodies[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: 'Show me the working directory',
        },
      ],
    });

    const secondResponse = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        previous_response_id: firstJson.id,
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_123',
            output: 'D:/project/ai-code/codeMUX',
          },
        ],
      }),
    });
    const secondJson = await secondResponse.json();

    expect(secondJson.status).toBe('completed');
    expect(secondJson.output).toHaveLength(1);
    expect(secondJson.output[0]).toMatchObject({
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'All set.',
        },
      ],
    });
    expect(upstreamBodies[1]).toMatchObject({
      messages: [
        {
          role: 'user',
          content: 'Show me the working directory',
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_123',
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

    // Issue 13: the proxy no longer emits CodeMUX timeline events — item
    // lifecycle is owned by the app-server runtime.
    const emittedEvents = stdoutWrites
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(emittedEvents.some((event) => typeof event.type === 'string' && event.type.startsWith('tool_'))).toBe(false);
  });

  it('streams synthesized responses SSE events for chat-completions providers', async () => {
    const upstream = createServer(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');

      const send = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send({
        id: 'chunk-1',
        model: 'mimo-v2-pro',
        choices: [{ index: 0, delta: { role: 'assistant', content: '<think>quick plan' }, finish_reason: null }],
      });
      send({
        id: 'chunk-2',
        model: 'mimo-v2-pro',
        choices: [{ index: 0, delta: { content: '</think>OK' }, finish_reason: 'stop' }],
      });
      send({
        id: 'chunk-done',
        model: 'mimo-v2-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      res.end('data: [DONE]\n\n');
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'proxy-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mimo-v2-pro',
        stream: true,
        input: [{ role: 'user', content: 'Say OK' }],
      }),
    });

    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('"type":"response.output_text.delta"');
    expect(body).toContain('"type":"response.output_item.done"');
    expect(body).toContain('"type":"response.completed"');
  });

  it('splits inline think tags into reasoning and text during streaming', async () => {
    const upstream = createServer(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      const send = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      send({ id: 'c1', model: 'qwen-plus', choices: [{ delta: { content: '<think>analysis...' }, finish_reason: null }] });
      send({ id: 'c2', model: 'qwen-plus', choices: [{ delta: { content: '</think>here is the answer' }, finish_reason: 'stop' }] });
      send({ id: 'c3', model: 'qwen-plus', choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-plus', stream: true, input: [{ role: 'user', content: 'test' }] }),
    });

    const body = await response.text();

    // Should contain reasoning deltas (from <think> content)
    expect(body).toContain('"type":"response.reasoning_summary_text.delta"');
    // Should contain text deltas (from content after </think>)
    expect(body).toContain('"type":"response.output_text.delta"');
    // Should complete normally
    expect(body).toContain('"type":"response.completed"');
  });

  it('injects stream_options for upstream requests', async () => {
    let receivedBody: any = null;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: [DONE]\n\n');
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.5-pro', stream: true, input: [{ role: 'user', content: 'Hi' }] }),
    });

    expect(receivedBody.stream_options).toEqual({ include_usage: true });
  });

  it('streams MCP tool calls with Responses namespace metadata', async () => {
    let receivedBody: any = null;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      const send = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      send({
        id: 'chunk-tool',
        model: 'mimo-v2-pro',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_context7',
              type: 'function',
              function: {
                name: 'mcp__context7__resolve_library_id',
                arguments: '{"libraryName":"MyBatis"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      res.end('data: [DONE]\n\n');
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2-pro',
        stream: true,
        input: [{ role: 'user', content: 'Use Context7' }],
        tools: [
          {
            type: 'namespace',
            name: 'mcp__context7',
            tools: [
              {
                type: 'function',
                name: 'resolve_library_id',
                description: 'Resolve a library ID',
                parameters: { type: 'object', properties: { libraryName: { type: 'string' } } },
              },
            ],
          },
        ],
      }),
    });

    const body = await response.text();

    expect(receivedBody.tools[0].function.name).toBe('mcp__context7__resolve_library_id');
    expect(body).toContain('"name":"resolve_library_id"');
    expect(body).toContain('"namespace":"mcp__context7"');
    expect(body).not.toContain('"name":"mcp__context7__resolve_library_id"');
  });

  it('passes request_user_input tool calls through as plain protocol data (no interception)', async () => {
    let upstreamCallCount = 0;
    const upstream = createServer(async (_req, res) => {
      upstreamCallCount++;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      const send = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({
        id: 'chunk-question',
        model: 'mimo-v2-pro',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_question',
              type: 'function',
              function: {
                name: 'request_user_input',
                arguments: JSON.stringify({
                  questions: [{ header: 'Scope', id: 'scope', question: 'Which scope?', options: [{ label: 'A', description: 'Use A' }] }],
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      res.end('data: [DONE]\n\n');
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2-pro',
        stream: true,
        input: [{ role: 'user', content: 'Ask me a question' }],
        tools: [{
          type: 'function',
          name: 'request_user_input',
          description: 'Ask the user',
          parameters: { type: 'object', properties: {} },
        }],
      }),
    });

    const body = await response.text();

    // Single upstream round-trip: no continuation loop.
    expect(upstreamCallCount).toBe(1);
    // The tool call streams through untouched; approvals live in app-server.
    expect(body).toContain('"type":"response.output_item.done"');
    expect(body).toContain('request_user_input');
    // No interactive events are emitted by the proxy anymore.
    expect(stdoutWrites.some((line) => line.includes('"type":"user_input_requested"'))).toBe(false);
  });

  it('sends only chat-completions-compatible function tools upstream', async () => {
    let receivedBody: any = null;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'mimo-v2-pro',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }));
    });

    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    }, 0);
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedBody.tools).toEqual([
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
