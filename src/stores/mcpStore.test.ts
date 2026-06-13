import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/tauri', () => ({
  mcpApi: {
    getAll: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    toggleApp: vi.fn(),
    probe: vi.fn(),
    probeAll: vi.fn(),
    importFromApps: vi.fn(),
  },
}));

import { useMcpStore } from './mcpStore';
import { mcpApi } from '../lib/tauri';

describe('mcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [{
        id: 'fetch',
        name: 'fetch',
        description: 'Web fetcher',
        server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
        apps: { claude: true, codex: false, gemini: false, opencode: false },
      }],
      probeStatus: {},
      isLoading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it('updates only one app flag when toggleApp succeeds', async () => {
    vi.mocked(mcpApi.toggleApp).mockResolvedValue();

    await useMcpStore.getState().toggleApp('fetch', 'codex', true);

    expect(useMcpStore.getState().servers[0].apps).toEqual({
      claude: true,
      codex: true,
      gemini: false,
      opencode: false,
    });
  });

  it('sets probe status to connected on successful probe', async () => {
    vi.mocked(mcpApi.probe).mockResolvedValue({ connected: true });

    await useMcpStore.getState().probeServer('fetch');

    expect(useMcpStore.getState().probeStatus['fetch']).toBe('connected');
  });

  it('sets probe status to failed on unsuccessful probe', async () => {
    vi.mocked(mcpApi.probe).mockResolvedValue({ connected: false });

    await useMcpStore.getState().probeServer('fetch');

    expect(useMcpStore.getState().probeStatus['fetch']).toBe('failed');
  });
});
