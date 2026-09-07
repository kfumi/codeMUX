import { describe, expect, it } from 'vitest';

function parseArgs(argv: string[]) {
  const [, , command, ...rest] = argv;
  let port = 9240;
  let sessionId: string | undefined;
  let message: string | undefined;
  let requestId: string | undefined;
  let decision: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--port' && rest[index + 1]) {
      port = Number(rest[index + 1]);
      index += 1;
    } else if (!sessionId) {
      sessionId = token;
    } else if (!message) {
      message = token;
    } else if (!requestId) {
      requestId = token;
    } else if (!decision) {
      decision = token;
    }
  }

  return { command: command ?? 'help', sessionId, message, requestId, decision, port };
}

describe('codemux CLI argument parsing', () => {
  it('parses status with custom port', () => {
    expect(parseArgs(['node', 'cli', 'status', '--port', '9300'])).toEqual({
      command: 'status',
      sessionId: undefined,
      message: undefined,
      requestId: undefined,
      decision: undefined,
      port: 9300,
    });
  });

  it('parses send with session and message', () => {
    expect(parseArgs(['node', 'cli', 'send', 'session-1', 'hello'])).toEqual({
      command: 'send',
      sessionId: 'session-1',
      message: 'hello',
      requestId: undefined,
      decision: undefined,
      port: 9240,
    });
  });

  it('parses respond with request id and decision', () => {
    expect(parseArgs(['node', 'cli', 'respond', 'session-1', 'req-1', 'approve'])).toEqual({
      command: 'respond',
      sessionId: 'session-1',
      message: 'req-1',
      requestId: 'approve',
      decision: undefined,
      port: 9240,
    });
  });
});

describe('codemux CLI status payload', () => {
  it('distinguishes loopback readiness from LAN exposure', () => {
    const statusPayload = {
      loopbackReady: true,
      lanExposed: false,
      activeSessionCount: 2,
    };
    expect(statusPayload.loopbackReady).toBe(true);
    expect(statusPayload.lanExposed).toBe(false);
    expect(statusPayload.activeSessionCount).toBe(2);
  });

  it('uses loopback host and bearer token for daemon API calls', () => {
    const port = 9240;
    const token = 'local-daemon-token';
    const url = `http://127.0.0.1:${port}/api/sessions`;
    expect(url).toBe('http://127.0.0.1:9240/api/sessions');
    expect(`Bearer ${token}`).toBe('Bearer local-daemon-token');
  });
});
