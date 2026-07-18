// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolGroupRoot, ToolGroupTrigger } from './tool-group';

function renderTrigger(toolNames: string[]) {
  return render(
    <ToolGroupRoot>
      <ToolGroupTrigger count={toolNames.length} toolNames={toolNames} />
    </ToolGroupRoot>,
  );
}

describe('ToolGroupTrigger', () => {
  it('uses Chinese names for grouped built-in agent tools', () => {
    renderTrigger(['Read', 'Read', 'shell_command']);

    expect(screen.getByText('已执行 读取文件(2)、运行命令(1)')).toBeTruthy();
    expect(screen.queryByText(/Read/)).toBeNull();
    expect(screen.queryByText(/shell_command/)).toBeNull();
  });

  it('summarizes MCP grouped tools by server name only', () => {
    renderTrigger(['mcp__context7__resolve-library-id', 'mcp__context7__query_docs']);

    expect(screen.getByText('已执行 context7(2)')).toBeTruthy();
    expect(screen.queryByText(/mcp__/)).toBeNull();
    expect(screen.queryByText(/query_docs/)).toBeNull();
    expect(screen.queryByText(/resolve-library-id/)).toBeNull();
  });
});
