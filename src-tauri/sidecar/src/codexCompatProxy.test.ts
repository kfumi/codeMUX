import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import { createCodexCompatProxyServer } from './codexCompatProxy.js';

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

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('createCodexCompatProxyServer', () => {
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

  it('translates responses requests into chat completions and preserves tool-call history', async () => {
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
  });

  it('streams synthesized responses SSE events for chat-completions providers', async () => {
    const upstream = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'mimo-v2-pro',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '<think>quick plan</think>OK',
            },
            finish_reason: 'stop',
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
});
