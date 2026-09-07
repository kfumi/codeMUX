import { beforeEach, describe, expect, it, vi } from 'vitest';

const mcpMocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  toggleApp: vi.fn(),
  probe: vi.fn(),
  probeAll: vi.fn(),
  importFromApps: vi.fn(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    mcp: mcpMocks,
  },
}));

import { useMcpStore } from './mcpStore';

describe('mcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [{
        id: 'fetch',
        name: 'fetch',
        description: 'Web fetcher',
        server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
        apps: { claude: true, codex: false, gemini: false, opencode: false, pi: false },
      }],
      probeStatus: {},
      isLoading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it('updates only one app flag when toggleApp succeeds', async () => {
    mcpMocks.toggleApp.mockResolvedValue(undefined);

    await useMcpStore.getState().toggleApp('fetch', 'codex', true);

    expect(useMcpStore.getState().servers[0].apps).toEqual({
      claude: true,
      codex: true,
      gemini: false,
      opencode: false,
      pi: false,
    });
  });

  it('sets probe status to connected on successful probe', async () => {
    mcpMocks.probe.mockResolvedValue({ connected: true });

    await useMcpStore.getState().probeServer('fetch');

    expect(useMcpStore.getState().probeStatus['fetch']).toBe('connected');
  });

  it('sets probe status to failed on unsuccessful probe', async () => {
    mcpMocks.probe.mockResolvedValue({ connected: false });

    await useMcpStore.getState().probeServer('fetch');

    expect(useMcpStore.getState().probeStatus['fetch']).toBe('failed');
  });
});
