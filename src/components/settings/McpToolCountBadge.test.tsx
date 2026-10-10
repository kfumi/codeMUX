// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { McpToolCountBadge, McpToolNameList } from './McpToolCountBadge';

const BROWSER_TOOLS = ['browser_list', 'browser_click'];
const DESKTOP_TOOLS = ['computer_windows', 'computer_screenshot'];

describe('McpToolCountBadge', () => {
  afterEach(() => {
    cleanup();
  });

  it('徽章给出数量', () => {
    render(<McpToolCountBadge tools={[...BROWSER_TOOLS, ...DESKTOP_TOOLS]} />);
    expect(screen.getByText('· 4 个工具')).toBeTruthy();
  });

  it('内置 server 空清单说「未启用」,自建 server 空清单不渲染', () => {
    const { container: builtin } = render(<McpToolCountBadge tools={[]} builtin />);
    expect(builtin.textContent).toContain('未启用');

    cleanup();

    const { container: custom } = render(<McpToolCountBadge tools={[]} />);
    expect(custom.textContent).toBe('');
  });
});

describe('McpToolNameList', () => {
  afterEach(() => {
    cleanup();
  });

  it('列出全部工具名,并按内置工具面的两族分段', () => {
    render(<McpToolNameList tools={[...BROWSER_TOOLS, ...DESKTOP_TOOLS]} />);

    for (const name of [...BROWSER_TOOLS, ...DESKTOP_TOOLS]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText('浏览器 2')).toBeTruthy();
    expect(screen.getByText('桌面 2')).toBeTruthy();
  });

  it('第三方命名(两族前缀都不匹配)平铺,不硬造分组', () => {
    render(<McpToolNameList tools={['resolve-library-id', 'query_docs']} />);

    expect(screen.queryByText(/^浏览器 /)).toBeNull();
    expect(screen.queryByText(/^桌面 /)).toBeNull();
    expect(screen.getAllByText('resolve-library-id').length).toBeGreaterThan(0);
    expect(screen.getAllByText('query_docs').length).toBeGreaterThan(0);
  });

  it('悬停徽章后能看到全部工具名(Radix tooltip 延迟打开)', async () => {
    render(<McpToolCountBadge tools={[...BROWSER_TOOLS, ...DESKTOP_TOOLS]} />);
    const badge = screen.getByText('· 4 个工具');

    fireEvent.pointerEnter(badge);
    fireEvent.pointerMove(badge);

    await waitFor(
      () => expect(screen.getAllByText('browser_click').length).toBeGreaterThan(0),
      { timeout: 4000 },
    );
    expect(screen.getAllByText('computer_screenshot').length).toBeGreaterThan(0);
  });
});
