// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar';
import { TooltipProvider } from '../ui/tooltip';

// 平台固定成 win32：断言的键位文案与 aria 键名才与运行机器无关。
vi.mock('../../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32',
}));

// 这个文件只关心上下文侧栏里剩下的两个入口上的键位提示，子面板各自有测试。
vi.mock('../session/SessionList', () => ({ SessionList: () => <div /> }));
vi.mock('../workspace/ProjectExplorer', () => ({ ProjectExplorer: () => <div /> }));
vi.mock('../companion/CompanionSidebarButton', () => ({ CompanionSidebarButton: () => <div /> }));
vi.mock('./ChatSearchDialog', () => ({ ChatSearchDialog: () => <div /> }));
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (state: { fetchProjects: () => void }) => unknown) =>
    selector({ fetchProjects: () => {} }),
}));

const noop = () => {};

function renderSidebar() {
  render(
    <TooltipProvider>
      <Sidebar
        onNewSession={noop}
        onNewSessionInProject={noop}
        onSelectSession={noop}
      />
    </TooltipProvider>,
  );
}

/** 行按钮：文案 span 所属的那个 button。 */
function rowButton(label: string): HTMLButtonElement {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error(`没有找到「${label}」按钮`);
  return button as HTMLButtonElement;
}

describe('Sidebar 的键位提示', () => {
  afterEach(() => {
    cleanup();
  });

  it('新对话与搜索把当前键位显示在按钮右侧', () => {
    renderSidebar();

    // 键位必须能被发现：改键后提示跟着变（ADR 0013）。
    expect(rowButton('新对话').textContent).toContain('Ctrl+N');
    expect(rowButton('搜索').textContent).toContain('Ctrl+K');
    // 默认隐藏，鼠标移到那一行才出现（键盘聚焦时也要能看到）。
    const hint = screen.getByText('Ctrl+N');
    expect(hint.className).toContain('opacity-0');
    expect(hint.className).toContain('group-hover:opacity-100');
    expect(hint.className).toContain('group-focus-visible:opacity-100');
  });

  it('剩余的两个入口都写出 aria-keyshortcuts', () => {
    renderSidebar();

    expect(rowButton('新对话').getAttribute('aria-keyshortcuts')).toBe('Control+N');
    expect(rowButton('搜索').getAttribute('aria-keyshortcuts')).toBe('Control+K');
  });

  it('顶层导航已提到导航栏，侧栏不再有自动化 / 工单 / 设置入口', () => {
    renderSidebar();

    // 这三项搬到了 NavRail（见 NavRail.test.tsx）。这里钉住「不再重复出现」，
    // 免得同一个入口同时挂在两个地方，用户看到两个去处。
    for (const label of ['自动化', '待办任务', '工单', '设置']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
  });
});
