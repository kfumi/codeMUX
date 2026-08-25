// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolGroup, ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from './tool-group';

function renderTrigger(toolNames: string[]) {
  return render(
    <ToolGroupRoot>
      <ToolGroupTrigger count={toolNames.length} toolNames={toolNames} />
    </ToolGroupRoot>,
  );
}

describe('ToolGroupTrigger', () => {
  it('uses Chinese names for grouped built-in agent tools', () => {
    const { container } = renderTrigger(['Read', 'Read', 'shell_command']);
    const trigger = container.querySelector('[data-slot="tool-group-trigger"]');

    expect(container.querySelector('[data-slot="tool-group-trigger-summary"]')?.textContent).toBe('读取×2、运行命令×1');
    expect(screen.queryByText(/Read/)).toBeNull();
    expect(screen.queryByText(/shell_command/)).toBeNull();
    expect(trigger?.className).not.toContain('pl-1');
    expect(trigger?.className).toContain('font-normal');
    expect(container.querySelector('[data-slot="tool-group-trigger-icon"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-group-trigger-dot"]')?.className).toContain('mx-2');
    expect(container.querySelector('[data-slot="tool-group-trigger-label"]')?.className).not.toContain('font-medium');
    expect(container.querySelector('[data-slot="tool-group-trigger-chevron"]')?.getAttribute('class')).toContain('opacity-0');
    expect(container.querySelector('[data-slot="tool-group-trigger-chevron"]')?.getAttribute('class')).toContain('group-hover/trigger:opacity-100');
  });

  it('uses the tool group for a single tool', () => {
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={0} toolNames={['Read']}>
        <div>工具详情</div>
      </ToolGroup>,
    );

    expect(container.querySelector('[data-slot="tool-group-trigger-summary"]')?.textContent).toBe('读取×1');
    expect(container.querySelector('[data-slot="tool-group-root"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-group-trigger-icon"]')).toBeTruthy();
  });

  it('shows a shimmer state while tool execution is active', () => {
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={1} toolNames={['Read', 'Bash']} active>
        <div>工具详情</div>
      </ToolGroup>,
    );

    const root = container.querySelector('[data-slot="tool-group-root"]');
    const trigger = container.querySelector('[data-slot="tool-group-trigger"]');

    expect(root?.getAttribute('data-active')).toBe('true');
    expect(trigger?.getAttribute('data-active')).toBe('true');
    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[data-slot="tool-group-trigger-loader"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-group-trigger-shimmer"]')?.className).toContain('shimmer');
  });

  it('defaults to collapsed even while tools are running', () => {
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={1} toolNames={['Read', 'Bash']} active>
        <div>工具详情</div>
      </ToolGroup>,
    );

    expect(container.querySelector('[data-slot="tool-group-root"]')?.getAttribute('data-state')).toBe('closed');
    expect(container.querySelector('[data-slot="tool-group-content"]')?.getAttribute('data-state')).toBe('closed');
  });

  it('summarizes MCP grouped tools by server name only', () => {
    const { container } = renderTrigger(['mcp__context7__resolve-library-id', 'mcp__context7__query_docs']);

    expect(container.querySelector('[data-slot="tool-group-trigger-summary"]')?.textContent).toBe('context7×2');
    expect(screen.queryByText(/mcp__/)).toBeNull();
    expect(screen.queryByText(/query_docs/)).toBeNull();
    expect(screen.queryByText(/resolve-library-id/)).toBeNull();
  });

  it('summarizes more than three tool types instead of collapsing to a generic count', () => {
    const { container } = renderTrigger(['Read', 'Read', 'Task', 'Glob', 'Glob', 'Glob', 'Bash']);

    expect(container.querySelector('[data-slot="tool-group-trigger-summary"]')?.textContent).toBe(
      '读取×2、任务×1、匹配文件×3、运行命令×1',
    );
  });

  it('restores the native collapsible animation for grouped tools', () => {
    const { container } = render(
      <ToolGroupRoot defaultOpen>
        <ToolGroupTrigger count={2} />
        <ToolGroupContent>
          <div>工具详情</div>
        </ToolGroupContent>
      </ToolGroupRoot>,
    );

    const root = container.querySelector('[data-slot="tool-group-root"]') as HTMLElement;
    const content = container.querySelector('[data-slot="tool-group-content"]') as HTMLElement;

    expect(root.style.getPropertyValue('--animation-duration')).toBe('200ms');
    expect(content.className).toContain('animate-collapsible-down');
    expect(content.className).toContain('duration-(--animation-duration)');
    expect(container.querySelector('[data-slot="tool-group-rail"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-group-rail"]')?.className).toContain('left-2');
    expect(container.querySelector('[data-slot="tool-group-content"] .pl-5')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-group-trigger-chevron"]')?.getAttribute('class')).toContain('group-data-[state=open]/trigger:opacity-100');
  });
});
