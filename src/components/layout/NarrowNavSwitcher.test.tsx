// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NarrowNavSwitcher } from './NarrowNavSwitcher';

const workTaskState = vi.hoisted(() => ({
  tasks: [] as Array<{ status: string; needsAttention?: boolean }>,
  selectAttentionCount: () => workTaskState.tasks.filter((t) => t.needsAttention).length,
}));

vi.mock('../../stores/workTaskStore', () => ({
  useWorkTaskStore: (selector: (state: unknown) => unknown) => selector({ tasks: workTaskState.tasks }),
  selectAttentionCount: workTaskState.selectAttentionCount,
}));

const select = vi.fn();

function renderSwitcher(activeTarget: Parameters<typeof NarrowNavSwitcher>[0]['activeTarget'] = 'app') {
  return render(<NarrowNavSwitcher activeTarget={activeTarget} onSelect={select} />);
}

describe('NarrowNavSwitcher', () => {
  beforeEach(() => {
    select.mockClear();
    workTaskState.tasks = [];
  });

  afterEach(() => cleanup());

  it('carries the same three top-level views as the desktop rail, with visible labels', () => {
    renderSwitcher();

    const nav = screen.getByRole('navigation', { name: '视图切换' });
    expect(nav).toBeTruthy();
    // 图标轨在窄屏整条隐藏，三个顶层视图的入口必须一个不少地落到这一行上。
    expect(Array.from(nav.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual([
      '会话',
      '自动化',
      '工单',
    ]);
    // 窄屏没有 hover tooltip，图标含义靠同行的文字表达。
    expect(nav.textContent).toContain('会话');
    expect(nav.textContent).toContain('自动化');
    expect(nav.textContent).toContain('工单');
  });

  it('reports the clicked target', () => {
    renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: '自动化' }));
    expect(select).toHaveBeenCalledWith('automation');
  });

  it('marks exactly the active view with aria-current', () => {
    renderSwitcher('todo');

    expect(screen.getByRole('button', { name: '工单' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '会话' }).getAttribute('aria-current')).toBeNull();
  });

  it('badges the work-item segment only when something needs attention', () => {
    renderSwitcher();
    expect(screen.getByRole('button', { name: '工单' }).textContent).toBe('工单');

    workTaskState.tasks = [{ status: 'running', needsAttention: true }, { status: 'done' }];
    renderSwitcher();

    expect(screen.getAllByRole('button', { name: '工单' })[1].textContent).toBe('工单1');
  });

  it('sits on the sidebar surface: hover uses the sidebar tier, not the chrome tier', () => {
    renderSwitcher('automation');

    // 抽屉里这一行压在**侧栏面**上（`--sidebar-bg`），选中/悬停档取侧栏那一档；
    // 图标轨的 `--chrome-bg-hover` 是窗口面的悬停色，用在这里会只有几级差。
    expect(screen.getByRole('button', { name: '自动化' }).className).toContain(
      'bg-[hsl(var(--sidebar-muted))]',
    );
    expect(screen.getByRole('button', { name: '会话' }).className).not.toContain('--chrome-bg-hover');
  });
});
