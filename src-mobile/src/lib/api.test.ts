import { describe, expect, it } from 'vitest';

import { ApiRequestError, isAuthError, providerSupportsAgent, resolveDefaultProvider, type MobileBootstrap } from './api';

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
    opencode: { permissionMode: 'full_access' },
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

describe('isConnectivityError', () => {
  it('detects network failures but not auth errors', async () => {
    const { isConnectivityError } = await import('./api');
    expect(isConnectivityError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectivityError(new Error('连接超时，桌面端无响应'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError(503, 'Service Unavailable'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError(401, 'Invalid token'))).toBe(false);
  });
});
