// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s),
// 超时后遗留的 import 续体还会在 cleanup 之后二次 render,污染后续用例。
import { McpSettingsPanel } from './McpSettings';

const toggleApp = vi.fn();
const importFromApps = vi.fn();
const fetchServers = vi.fn().mockResolvedValue(undefined);
const probeServer = vi.fn();
const probeAll = vi.fn();

const mockState = {
  servers: [
    {
      id: 'fetch',
      name: 'fetch',
      description: 'Web fetcher',
      server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
      apps: { claude: true, codex: false, gemini: false, opencode: false, pi: false },
    },
    {
      id: 'codemux-control',
      name: 'codemux-control',
      description:
        '让智能体操作内置浏览器与桌面应用(截图、点击、输入)。可用工具随「浏览器控制」「电脑控制」设置变化。',
      server: {
        command: 'C:/Users/u/AppData/Local/Programs/CodeMUX/resources/daemon/codemux-daemon.exe',
        args: ['mcp-control', '--app-data-dir', 'C:/Users/u/AppData/Roaming/com.codemux.desktop'],
      },
      apps: { claude: true, codex: true, gemini: true, opencode: true, pi: true },
      builtin: true,
      tools: [
        'browser_list',
        'browser_eval',
        'browser_screenshot',
        'browser_input',
        'browser_cdp',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_scroll',
        'browser_select',
        'computer_windows',
        'computer_screenshot',
        'computer_active_window',
        'computer_apps',
        'computer_elements',
        'computer_wait',
        'computer_click',
        'computer_type',
        'computer_key',
        'computer_paste',
        'computer_scroll',
        'computer_drag',
        'computer_set_value',
        'computer_launch',
      ],
    },
  ],
  probeStatus: { fetch: 'idle' as const },
  probeTools: {},
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

// JSON 配置框走 CodeEditorSurface(Monaco 懒加载)。这里把真实的编辑器模块替掉,
// 避免单测去拉 AMD 运行时;宿主形态门控本身的覆盖见 components/code/CodeEditorSurface.test.tsx。
vi.mock('../code/MonacoCodeView', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="monaco-code-view" defaultValue={value} />,
}));

describe('McpSettingsPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders per-tool toggles and import button', async () => {
    render(<McpSettingsPanel />);

    // Import button exists
    expect(screen.getByText('从工具导入')).toBeTruthy();

    // Per-tool toggles exist
    expect(screen.getByLabelText('toggle-fetch-codex')).toBeTruthy();
    expect(screen.getByLabelText('toggle-fetch-claude')).toBeTruthy();
    expect(screen.getByLabelText('toggle-fetch-pi')).toBeTruthy();

    // Click codex toggle calls toggleApp with correct args
    fireEvent.click(screen.getByLabelText('toggle-fetch-codex'));
    expect(toggleApp).toHaveBeenCalledWith('fetch', 'codex', true);

    // Click import button calls importFromApps
    fireEvent.click(screen.getByText('从工具导入'));
    expect(importFromApps).toHaveBeenCalled();
  });

  it('内置 server:显示内置徽标,app 全亮且禁点,不出现编辑/删除/探测', async () => {
    render(<McpSettingsPanel />);

    // 分组展示:内置组在上,已安装组在下。
    const headings = screen.getAllByText('已安装');
    expect(headings.length).toBe(1);
    const builtinBadge = screen.getAllByText('内置');
    expect(builtinBadge.length).toBeGreaterThanOrEqual(1);
    expect(headings[0].compareDocumentPosition(builtinBadge[0]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    // 四个 app 图标都渲染,但全部 disabled(不触发 toggleApp)。
    for (const app of ['claude', 'codex', 'opencode', 'pi']) {
      const button = screen.getByLabelText(`toggle-codemux-control-${app}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    const before = toggleApp.mock.calls.length;
    fireEvent.click(screen.getByLabelText('toggle-codemux-control-codex'));
    expect(toggleApp.mock.calls.length).toBe(before);

    // 内置行没有 probe/edit/delete 按钮(fetch 行才有)。
    expect(screen.getByLabelText('toggle-fetch-codex')).toBeTruthy();
    expect(screen.queryByLabelText(`builtin-codemux-control`)).toBeTruthy();
    // 内置行不渲染探测/编辑按钮:同一行只有锁图标(aria builtin-*)。
    const lockIcon = screen.getByLabelText('builtin-codemux-control');
    expect(lockIcon).toBeTruthy();

    // 工具数由 daemon 现算(方案 A):徽章给数量,tooltip 里是全部工具名。
    expect(screen.getByText('· 24 个工具')).toBeTruthy();
    // 内置行只展示命令形态:绝对安装路径不进页面(真实命令在 tooltip 里)。
    expect(screen.getByText('codemux-daemon mcp-control --app-data-dir <数据目录>')).toBeTruthy();
    expect(screen.queryByText(/resources\/daemon/)).toBeNull();
  });
});
