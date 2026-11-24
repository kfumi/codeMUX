// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../ui/tooltip';
import { CodeMuxToolCallMessagePart } from './assistant-ui/CodeMuxMessageParts';

// 行渲染已收进 CodeMuxMessageParts 的 tool-call part（旧 ToolCallCard 已删除），
// 这里 mock 掉只有侧面板才需要的 facade，让 part 能在 jsdom 里独立挂载。
vi.mock('@/lib/facades/daemon-facade', () => ({
  daemonFacade: {
    workspace: {
      previewImage: vi.fn(),
    },
  },
}));

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/** 组头行；展开/收起都点它。 */
function triggerOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="tool-fallback-trigger"]') as HTMLElement;
}

describe('tool header summaries', () => {
  it('shows Read file name in the header instead of the full path', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Read"
        args={{ file_path: 'D:\\project\\src\\App.tsx' }}
      />,
    );

    // 头部只给文件名，完整路径留给 tooltip。
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(container.textContent).not.toContain('D:\\project\\src');
  });

  it('shows Bash command in the header', () => {
    renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Bash"
        args={{ description: 'Run typecheck', command: 'npm run build' }}
      />,
    );

    expect(screen.getByText('npm run build')).toBeTruthy();
    // 命令本身就是头部摘要，description 不进头部。
    expect(screen.queryByText('Run typecheck')).toBeNull();
  });

  it('renders shell_command as a command panel and keeps it out of the args block', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="shell_command"
        args={{ command: 'node --check script.js', timeout_ms: 10000, workdir: 'D:\\project\\ai-code\\code-demo' }}
        result="ok"
      />,
    );

    expect(screen.getByText('node --check script.js')).toBeTruthy();

    fireEvent.click(triggerOf(container));

    // 命令工具走终端面板：命令只出现一次，参数 JSON 不再重复整份输入。
    expect(container.querySelector('[data-slot="tool-fallback-command"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
  });

  it('shows Grep pattern and Agent description in the header', () => {
    renderWithTooltip(
      <>
        <CodeMuxToolCallMessagePart toolName="Grep" args={{ pattern: 'CodeMuxToolCallMessagePart', path: 'src' }} />
        <CodeMuxToolCallMessagePart
          toolName="Agent"
          args={{ description: 'Explore tool message rendering', prompt: 'Full prompt' }}
        />
      </>,
    );

    expect(screen.getByText('CodeMuxToolCallMessagePart')).toBeTruthy();
    expect(screen.getByText('Explore tool message rendering')).toBeTruthy();
  });

  it('names Claude TaskStop in the accessible label', () => {
    const { container } = renderWithTooltip(<CodeMuxToolCallMessagePart toolName="TaskStop" args={{}} />);

    // 动作词是「委派」（它是子智能体类工具），具体工具名由无障碍名补上。
    const label = triggerOf(container).getAttribute('aria-label') ?? '';
    expect(label).toContain('子智能体结束');
    expect(label).not.toContain('TaskStop');
  });

  it('names Codex multi_agent spawn_agent in the accessible label', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="multi_agent_v1__spawn_agent"
        args={{
          fork_context: true,
          items: [{ type: 'text', text: 'Find all files related to message regenerating' }],
        }}
      />,
    );

    const label = triggerOf(container).getAttribute('aria-label') ?? '';
    expect(label).toContain('启动子智能体');
    expect(label).not.toContain('multi_agent_v1__spawn_agent');

    fireEvent.click(triggerOf(container));
    // 展开面板保留原始参数（这是 live 组件与旧 ToolCallCard 的差异，不是回归）。
    expect(container.textContent).toContain('"fork_context"');
    expect(container.textContent).toContain('"items"');
  });
});

describe('浏览器工具 header 摘要', () => {
  it('点击元素在标题显示编号', () => {
    renderWithTooltip(
      <CodeMuxToolCallMessagePart toolName="browser_click" args={{ elementId: 'e3', browserId: 'b-1' }} />,
    );
    expect(screen.getByText('点击页面元素')).toBeTruthy();
    expect(screen.getByText('e3')).toBeTruthy();
  });

  it('输入文字标题只显示编号与字数，不泄露内容', () => {
    renderWithTooltip(
      <CodeMuxToolCallMessagePart toolName="browser_type" args={{ elementId: 'e1', text: 'hello' }} />,
    );
    expect(screen.getByText('输入页面文字')).toBeTruthy();
    expect(screen.queryByText('hello')).toBeNull();
  });

  it('快照工具显示中文名', () => {
    renderWithTooltip(<CodeMuxToolCallMessagePart toolName="browser_snapshot" args={{}} />);
    expect(screen.getByText('读取页面快照')).toBeTruthy();
  });
});
