import { describe, expect, it } from 'vitest';

import {
  ApiRequestError,
  isAuthError,
  providerSupportsAgent,
  resolveDefaultProvider,
  shouldAttemptDirectPairing,
  type MobileBootstrap,
} from './api';

const bootstrap: MobileBootstrap = {
  defaultAgentKind: 'claude_code',
  activeProviderId: 'provider-2',
  providers: [
    {
      id: 'provider-1',
      name: 'Anthropic',
      enabled: true,
      configured: true,
      defaultModel: 'sonnet',
      models: [{ id: 'sonnet' }],
      protocols: ['anthropic'],
    },
    {
      id: 'provider-2',
      name: 'OpenAI',
      enabled: true,
      configured: true,
      defaultModel: 'gpt-5',
      models: [{ id: 'gpt-5' }],
      protocols: ['openai_compatible'],
    },
  ],
  agentDefaults: {
    claude_code: { providerId: 'provider-1', model: 'sonnet' },
    codex: { providerId: 'provider-2', model: 'gpt-5' },
    opencode: { providerId: null, model: null },
  },
  reasoningEfforts: ['high'],
  permissionPresets: {
    claude_code: { permissionMode: 'default' },
    codex: { sandboxMode: 'danger-full-access' },
    opencode: { autoApprovePermissions: false },
  },
};

describe('providerSupportsAgent', () => {
  it('matches protocol to agent kind', () => {
    expect(providerSupportsAgent(bootstrap.providers[0], 'claude_code')).toBe(true);
    expect(providerSupportsAgent(bootstrap.providers[0], 'codex')).toBe(false);
  });
});

describe('resolveDefaultProvider', () => {
  it('prefers agent-specific default provider', () => {
    expect(resolveDefaultProvider(bootstrap, 'claude_code')?.id).toBe('provider-1');
    expect(resolveDefaultProvider(bootstrap, 'codex')?.id).toBe('provider-2');
  });
});

describe('request helpers', () => {
  it('accepts empty 202 responses for send message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 202 });
    const { sendSessionMessage } = await import('./api');
    await expect(sendSessionMessage(
      {
        desktopId: 'desktop-1',
        deviceId: 'device',
        token: 'token',
        connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://localhost:9240' }],
      },
      'session-1',
      'hello',
    )).resolves.toBeUndefined();
    globalThis.fetch = originalFetch;
  });

  it('reads the desktop runtime state from the session state endpoint', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      return Response.json({ running: false });
    };

    const { fetchSessionRuntimeState } = await import('./api');
    await expect(fetchSessionRuntimeState(
      {
        desktopId: 'desktop-1',
        deviceId: 'device',
        token: 'token',
        connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://localhost:9240' }],
      },
      'session-1',
    )).resolves.toEqual({ running: false });

    expect(requestUrl).toContain('/api/sessions/session-1/state');
    globalThis.fetch = originalFetch;
  });

  it('sends input payload images with the mobile message', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = '';
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(null, { status: 202 });
    };

    const { sendSessionMessage } = await import('./api');
    await sendSessionMessage(
      {
        desktopId: 'desktop-1',
        deviceId: 'device',
        token: 'token',
        connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://localhost:9240' }],
      },
      'session-1',
      '请查看这张图',
      {
        text: '请查看这张图',
        attachments: [{
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
        }],
      },
    );

    expect(JSON.parse(requestBody)).toMatchObject({
      prompt: '请查看这张图',
      inputPayload: {
        text: '请查看这张图',
        attachments: [{
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
        }],
      },
    });
    globalThis.fetch = originalFetch;
  });

  it('patches all session settings atomically', async () => {
    const originalFetch = globalThis.fetch;
    let requestMethod = '';
    let requestBody = '';
    globalThis.fetch = async (_input, init) => {
      requestMethod = init?.method ?? '';
      requestBody = String(init?.body ?? '');
      return Response.json({
        id: 'session-1',
        title: 'Test',
        agent_kind: 'codex',
        updated_at: '2026-08-18T00:00:00Z',
      });
    };

    const { updateSessionSettings } = await import('./api');
    await expect(updateSessionSettings(
      {
        desktopId: 'desktop-1',
        deviceId: 'device',
        token: 'token',
        connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://localhost:9240' }],
      },
      'session-1',
      {
        agentKind: 'codex',
        providerId: 'provider-1',
        model: 'gpt-5',
        reasoningEffort: 'high',
        permissionConfig: { kind: 'codex', sandboxMode: 'danger-full-access' },
        planMode: 'off',
      },
    )).resolves.toMatchObject({ agent_kind: 'codex' });
    expect(requestMethod).toBe('PATCH');
    expect(JSON.parse(requestBody)).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5',
      planMode: 'off',
    });
    globalThis.fetch = originalFetch;
  });
});

describe('isAuthError', () => {
  it('detects unauthorized API responses', () => {
    expect(isAuthError(new ApiRequestError(401, 'Invalid token'))).toBe(true);
    expect(isAuthError(new ApiRequestError(500, 'boom'))).toBe(false);
  });
});

describe('formatPairingClaimError', () => {
  it('maps invalid pairing code responses to a friendly message', async () => {
    const { formatPairingClaimError, ApiRequestError: RequestError } = await import('./api');
    expect(formatPairingClaimError(new RequestError(400, 'Invalid or expired pairing code'))).toBe(
      '配对码无效或已过期，请让桌面刷新二维码',
    );
  });
});

describe('pairing transport selection', () => {
  it('skips HTTP desktop pairing from an HTTPS page', () => {
    expect(shouldAttemptDirectPairing('http://198.18.0.1:9241', 'https:')).toBe(false);
    expect(shouldAttemptDirectPairing('https://198.18.0.1:9241', 'https:')).toBe(true);
    expect(shouldAttemptDirectPairing('http://198.18.0.1:9241', 'http:')).toBe(true);
  });
});

describe('isConnectivityError', () => {
  it('detects network failures but not auth errors', async () => {
    const { isConnectivityError } = await import('./api');
    expect(isConnectivityError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectivityError(new Error('连接超时，桌面端无响应'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError(503, 'Service Unavailable'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError(401, 'Invalid token'))).toBe(false);
  });
});
