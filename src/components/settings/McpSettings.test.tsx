// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const toggleApp = vi.fn();
const importFromApps = vi.fn();
const fetchServers = vi.fn().mockResolvedValue(undefined);
const probeServer = vi.fn();
const probeAll = vi.fn();

const mockState = {
  servers: [{
    id: 'fetch',
    name: 'fetch',
    description: 'Web fetcher',
    server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
    apps: { claude: true, codex: false, gemini: false, opencode: false },
  }],
  probeStatus: { fetch: 'idle' as const },
  isLoading: false,
  error: null,
  fetchServers,
  upsertServer: vi.fn(),
  deleteServer: vi.fn(),
  toggleApp,
  probeServer,
  probeAll,
  importFromApps,
};

vi.mock('../../stores/mcpStore', () => ({
  useMcpStore: (selector?: (state: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="codemirror" defaultValue={value} />,
}));

describe('McpSettingsPanel', () => {
  it('renders per-tool toggles and import button', async () => {
    const { McpSettingsPanel } = await import('./McpSettings');
    render(<McpSettingsPanel />);

    // Import button exists
    expect(screen.getByText('从工具导入')).toBeTruthy();

    // Per-tool toggles exist
    expect(screen.getByLabelText('toggle-fetch-codex')).toBeTruthy();
    expect(screen.getByLabelText('toggle-fetch-claude')).toBeTruthy();

    // Click codex toggle calls toggleApp with correct args
    fireEvent.click(screen.getByLabelText('toggle-fetch-codex'));
    expect(toggleApp).toHaveBeenCalledWith('fetch', 'codex', true);

    // Click import button calls importFromApps
    fireEvent.click(screen.getByText('从工具导入'));
    expect(importFromApps).toHaveBeenCalled();
  });
});
