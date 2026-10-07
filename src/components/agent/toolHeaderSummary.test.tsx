// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';
import { TooltipProvider } from '../ui/tooltip';

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('tool header summaries', () => {
  it('shows Read file name in the header (not full path) and removes it from expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Read"
        input={{
          file_path: 'D:\\project\\src\\App.tsx',
        }}
        status="done"
      />,
    );

    // Now shows only filename, not full path
    expect(screen.getByText('App.tsx')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"file_path"');
  });

  it('shows Bash command in the header without expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Bash"
        input={{
          description: 'Run typecheck',
          command: 'npm run build',
        }}
        status="done"
      />,
    );

    expect(screen.getByText('npm run build')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"description"');
    expect(container.textContent).not.toContain('"command"');
  });

  it('shows shell_command command in the header and keeps it in expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="shell_command"
        input={{
          command: 'node --check script.js',
          timeout_ms: 10000,
          workdir: 'D:\\project\\ai-code\\code-demo',
        }}
        status="done"
      />,
    );

    expect(screen.getByText('node --check script.js')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).toContain('"command"');
    expect(container.textContent).toContain('"timeout_ms"');
    expect(container.textContent).toContain('"workdir"');
  });

  it('shows Grep pattern and Agent description in the header', () => {
    renderWithTooltip(
      <>
        <ToolCallCard toolName="Grep" input={{ pattern: 'ToolCallCard', path: 'src' }} status="done" />
        <ToolCallCard toolName="Agent" input={{ description: 'Explore tool message rendering', prompt: 'Full prompt' }} status="done" />
      </>,
    );

    expect(screen.getByText('ToolCallCard')).toBeTruthy();
    expect(screen.getByText('Explore tool message rendering')).toBeTruthy();
  });

  it('shows Claude TaskStop with a Chinese display name', () => {
    renderWithTooltip(<ToolCallCard toolName="TaskStop" input={{}} status="done" />);

    expect(screen.getByText('子智能体结束')).toBeTruthy();
    expect(screen.queryByText('TaskStop')).toBeNull();
  });

  it('shows Codex multi_agent spawn_agent with a Chinese display name', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="multi_agent_v1__spawn_agent"
        input={{
          fork_context: true,
          items: [{ type: 'text', text: 'Find all files related to message regenerating' }],
        }}
        status="done"
      />,
    );

    expect(screen.getByText('启动子智能体')).toBeTruthy();
    expect(screen.queryByText('multi_agent_v1__spawn_agent')).toBeNull();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"fork_context"');
    expect(container.textContent).toContain('"items"');
  });
});
describe('浏览器工具 header 摘要', () => {
  it('点击元素在标题显示编号，展开参数不再重复', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard toolName={'browser_click'} input={{ elementId: 'e3', browserId: 'b-1' }} status={'done'} />,
    );
    expect(screen.getByText('点击元素')).toBeTruthy();
    expect(screen.getByText('e3')).toBeTruthy();
    fireEvent.click(within(container).getByRole('button'));
    expect(container.textContent).not.toContain('elementId');
  });
  it('输入文字标题只显示编号与字数，不泄露内容', () => {
    renderWithTooltip(
      <ToolCallCard toolName={'browser_type'} input={{ elementId: 'e1', text: 'hello' }} status={'done'} />,
    );
    expect(screen.getByText('输入文字')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
  });
  it('快照工具显示中文名', () => {
    renderWithTooltip(
      <ToolCallCard toolName={'browser_snapshot'} input={{}} status={'done'} />,
    );
    expect(screen.getByText('读取页面快照')).toBeTruthy();
  });
});
