// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CheckSquare, SquareTerminal } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPreviewImageFile } = vi.hoisted(() => ({ mockPreviewImageFile: vi.fn() }));
vi.mock('@/lib/facades/daemon-facade', () => ({
  daemonFacade: { previewImageFile: mockPreviewImageFile },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { useSubagentStore } from '../../../stores/subagentStore';
import { usePreviewStore } from '../../../stores/previewStore';
import { getKnownSidecarErrorDisplay, getStreamStatusDisplay } from './CodeMuxMessageParts';
import { CodeMuxDataMessagePart, CodeMuxToolCallMessagePart } from './CodeMuxMessageParts';

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('getStreamStatusDisplay', () => {
  it('renders Codex mode-blocked diagnostics without labeling them as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'Codex collaboration mode blocked item/tool/requestUserInput: request_user_input_blocked_in_default_mode.',
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/requestUserInput',
        effective_mode: 'code',
        reason_code: 'request_user_input_blocked_in_default_mode',
        reason: 'requestUserInput is blocked while effective_mode=code',
        suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
        request_id: 'tool-1',
      },
    });

    expect(display.tone).toBe('warning');
    expect(display.text).toContain('权限门拦截');
    expect(display.text).toContain('request_user_input_blocked_in_default_mode');
    expect(display.text).not.toContain('连接断开');
  });

  it('names whose permission gate blocked a computer-use step', () => {
    const display = getStreamStatusDisplay({
      message: 'blocked',
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/mcp__codemux-control__browser_click',
        effective_mode: 'code',
        reason_code: 'permission_mode_blocked',
        gate_agent_kind: 'codex',
        gate_label: 'Codex 的权限门',
      },
    });

    expect(display.text).toContain('Codex 的权限门拦截');
    expect(display.text).toContain('permission_mode_blocked');
  });

  it('falls back to a generic label when the gate owner is unknown', () => {
    const display = getStreamStatusDisplay({
      message: 'blocked',
      is_reconnecting: false,
      mode_blocked: { reason_code: 'permission_mode_blocked' },
    });

    expect(display.text).toContain('智能体权限门拦截');
  });

  it('keeps non-reconnecting stream failures labeled as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'stream closed before response.completed',
      is_reconnecting: false,
    });

    expect(display.tone).toBe('error');
    expect(display.text).toBe('连接断开: stream closed before response.completed');
  });
});

describe('CodeMuxToolCallMessagePart', () => {
  beforeEach(() => {
    useSidePanelStore.getState().reset();
    mockPreviewImageFile.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('没有子智能体描述符时委派工具调用退化成普通工具行，不再渲染子智能体详情面板', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Agent"
        args={{ description: '检查消息渲染', prompt: '内部子智能体提示词\n\n请只返回结论' }}
        result="子智能体最终结果：已完成"
      />,
    );

    // 找不到描述符时无法确认这是真正的委派：保留工具行，委派不会在对话流里凭空消失。
    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    expect(trigger).not.toBeNull();
    // 子智能体预览入口由委派卡片的节点卡承担，工具行上不再挂 chip。
    expect(container.querySelector('[data-slot="subagent-preview-chip"]')).toBeNull();
    expect(screen.queryByText(/内部子智能体提示词/)).toBeNull();

    fireEvent.click(trigger as HTMLElement);

    // 展开后是普通工具参数/结果详情，不再走子智能体对话式气泡。
    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');
    expect(argsBlock?.textContent).toContain('内部子智能体提示词');
    expect(argsBlock?.className).not.toContain('justify-end');
    expect(resultBlock?.textContent).toContain('子智能体最终结果');
  });

  it('电脑启动工具把应用名摘要显示在工具名右侧', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="codemux-control_computer_launch"
        args={{ name: 'Notepad' }}
        result="started"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    expect(trigger?.textContent).toContain('启动桌面应用');
    expect(trigger?.textContent).toContain('Notepad');
  });

  it('保存截图工具从实际路径参数加载图片并可点击预览', async () => {
    mockPreviewImageFile.mockResolvedValueOnce('data:image/png;base64,UE5H');
    const path = String.raw`C:\Users\94910\Desktop\notepad_test123.png`;
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="codemux-control_computer_save_screenshot"
        args={{ path }}
        result=""
      />,
    );

    expect(mockPreviewImageFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /保存窗口截图/ }));
    const preview = await screen.findByRole('button', { name: '预览图片 notepad_test123.png' });
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(preview.className).toContain('max-h-40');
    expect(preview.querySelector('img')?.className).toContain('object-contain');
    const contentBody = container.querySelector('[data-slot="tool-fallback-content"]')?.firstElementChild;
    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(mockPreviewImageFile).toHaveBeenCalledWith(path);
  });

  it('Read 工具返回成功文本时按图片路径加载并可点击预览', async () => {
    mockPreviewImageFile.mockResolvedValueOnce('data:image/png;base64,UE5H');
    const path = String.raw`C:\Users\94910\Desktop\notepad_test123.png`;
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Read"
        args={{ filePath: path }}
        result="Image read successfully"
      />,
    );

    expect(mockPreviewImageFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /读取/ }));
    const preview = await screen.findByRole('button', { name: '预览图片 notepad_test123.png' });
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(mockPreviewImageFile).toHaveBeenCalledWith(path);
  });

  it('Read 普通文本文件时仍展示参数和结果', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Read"
        args={{ filePath: 'C:/Users/94910/Desktop/notes.txt' }}
        result="普通文本内容"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /读取/ }));

    expect(container.querySelector('[data-slot="tool-fallback-args"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')?.textContent).toContain('普通文本内容');
    expect(container.querySelector('[data-slot="tool-result-images"]')).toBeNull();
    expect(mockPreviewImageFile).not.toHaveBeenCalled();
  });

  it('保存截图工具展开后只显示图片，并可点击预览', () => {
    const screenshot = 'UE5H';
    const result = JSON.stringify({
      content: [
        { type: 'image', data: screenshot, mimeType: 'image/png' },
        { type: 'text', text: '截图已保存' },
      ],
    });
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="codemux-control_computer_save_screenshot"
        args={{ path: 'D:/Desktop/screenshot.png', processId: 1, windowId: 2 }}
        result={result}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /保存窗口截图/ }));
    const preview = screen.getByRole('button', { name: '预览图片 screenshot.png' });
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(preview.className).toContain('max-h-40');
    expect(preview.querySelector('img')?.className).toContain('max-h-40');
    const contentBody = container.querySelector('[data-slot="tool-fallback-content"]')?.firstElementChild;
    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(container.textContent).not.toContain(screenshot);
    expect(mockPreviewImageFile).not.toHaveBeenCalled();

    fireEvent.click(preview);
    expect(screen.getAllByAltText('screenshot.png')).toHaveLength(2);
  });

  it('读取图片文件时只显示图片，并可点击预览', () => {
    const result = JSON.stringify([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      { type: 'text', text: 'Image read successfully' },
    ]);
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Read"
        args={{ file_path: 'D:/Desktop/notepad.png' }}
        result={result}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /读取/ }));
    const preview = screen.getByRole('button', { name: '预览图片 notepad.png' });
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(container.textContent).not.toContain('UE5H');
    expect(mockPreviewImageFile).not.toHaveBeenCalled();

    fireEvent.click(preview);
    expect(screen.getAllByAltText('notepad.png')).toHaveLength(2);
  });

  it('图片读取失败时也隐藏参数和结果，只保留图片加载提示', async () => {
    mockPreviewImageFile.mockRejectedValueOnce(new Error('图片预览接口暂不可用'));
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Read"
        args={{ filePath: String.raw`C:\Users\94910\Desktop\notepad_test123.png` }}
        result="Image read successfully"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /读取/ }));

    expect(await screen.findByText('图片预览加载失败')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
  });

  it('普通工具参数和结果保持原始详情样式，不使用子智能体对话式气泡或 Markdown 渲染', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Grep"
        args={{ pattern: '**not bold**', path: 'src' }}
        result="结果包含 **not bold**"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /搜索文本/ }));

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const chevron = container.querySelector('[data-slot="tool-fallback-trigger-chevron"]');
    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');
    const toolRoot = container.querySelector('[data-slot="tool-fallback-root"]') as HTMLElement;
    const toolContent = container.querySelector('[data-slot="tool-fallback-content"]') as HTMLElement;

    expect(trigger?.className).toContain('font-normal');
    expect(trigger?.querySelector('b')).toBeNull();
    expect(chevron?.getAttribute('class')).toContain('opacity-0');
    expect(chevron?.getAttribute('class')).toContain('group-hover/trigger:opacity-100');
    expect(chevron?.getAttribute('class')).toContain('group-data-[state=open]/trigger:opacity-100');
    expect(argsBlock?.className).not.toContain('justify-end');
    expect(resultBlock?.className).not.toContain('justify-start');
    expect(resultBlock?.querySelector('strong')).toBeNull();
    expect(resultBlock?.textContent).toContain('结果包含 **not bold**');
    expect(resultBlock?.textContent).toContain('结果：');
    expect(toolRoot.style.getPropertyValue('--animation-duration')).toBe('200ms');
    expect(toolContent.className).toContain('animate-collapsible-down');
    expect(toolContent.className).toContain('duration-(--animation-duration)');
  });

  it('待办工具展开后渲染成一行行待办，不再展示参数 JSON', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="TodoWrite"
        args={{
          todos: [
            { content: '读取代码', status: 'completed' },
            { content: '修改实现', status: 'in_progress', activeForm: '正在修改实现' },
            { content: '补充测试', status: 'pending' },
          ],
        }}
        result="Todos have been modified successfully."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /更新待办/ }));

    const list = container.querySelector('[data-slot="tool-todo-list"]');
    const rows = container.querySelectorAll('[data-slot="tool-todo-item"]');
    expect(list).not.toBeNull();
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-status')).toBe('completed');
    expect(rows[1].getAttribute('data-status')).toBe('in_progress');
    expect(rows[2].getAttribute('data-status')).toBe('pending');

    // 进行中且有 activeForm 时展示进行时文案
    expect(rows[1].textContent).toContain('正在修改实现');
    // 每行前面都有状态图标
    expect(container.querySelectorAll('[data-slot="todo-status-icon"]')).toHaveLength(3);

    // 参数 JSON 与原始结果都不再展示
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.textContent).not.toContain('"todos"');
    expect(container.textContent).not.toContain('Todos have been modified');
  });

  it('Codex update_plan 用 plan[].step 渲染，并在列表上方显示 explanation', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="update_plan"
        args={{
          explanation: '计划已全部完成',
          plan: [
            { step: 'Step 1', status: 'completed' },
            { step: 'Step 2', status: 'in_progress' },
          ],
        }}
        result="plan updated"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /更新计划/ }));

    const rows = container.querySelectorAll('[data-slot="tool-todo-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Step 1');
    expect(rows[1].textContent).toContain('Step 2');
    expect(container.querySelector('[data-slot="tool-todo-list"]')?.textContent).toContain('计划已全部完成');
    expect(container.textContent).not.toContain('"plan"');
  });

  it('未知工具名但带 todos 数组时也按待办渲染', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="some_future_todo_tool"
        args={{ todos: [{ content: 'A', status: 'pending' }] }}
        result="ok"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /some_future_todo_tool/ }));

    expect(container.querySelectorAll('[data-slot="tool-todo-item"]')).toHaveLength(1);
    expect(container.textContent).not.toContain('"todos"');
  });

  it('非待办工具即使带 plan 数组也不会被当成待办渲染', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Agent"
        args={{ plan: [{ step: 'sub step', status: 'pending' }] }}
        result="ok"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子智能体/ }));

    expect(container.querySelector('[data-slot="tool-todo-list"]')).toBeNull();
  });

  it('待办/计划工具行使用待办图标，而不是兜底的扳手图标', () => {
    // lucide 会给图标加 `lucide-<name>` class，用它区分不同图标（名字随 lucide 版本变）。
    const iconName = (root: HTMLElement) =>
      root.querySelector('svg')?.getAttribute('class')?.match(/lucide-[a-z-]+/)?.[0];
    const triggerIconName = (root: HTMLElement) =>
      iconName(root.querySelector('[data-slot="tool-fallback-trigger"]') as HTMLElement);

    const todoIcon = iconName(render(<CheckSquare />).container);
    const terminalIcon = iconName(render(<SquareTerminal />).container);
    expect(todoIcon).toBeTruthy();
    expect(todoIcon).not.toBe(terminalIcon);

    for (const toolName of ['TodoWrite', 'todowrite', 'update_plan', 'TaskList']) {
      const { container, unmount } = renderWithTooltip(
        <CodeMuxToolCallMessagePart toolName={toolName} args={{}} result="ok" />,
      );
      expect(triggerIconName(container), toolName).toBe(todoIcon);
      unmount();
    }

    // 其他工具不受影响，仍用各自的动作图标
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart toolName="Bash" args={{ command: 'ls' }} result="ok" />,
    );
    expect(triggerIconName(container)).toBe(terminalIcon);
  });

  it('工具标题行按内容收缩，参数可截断但不把折叠按钮和 diff 统计推到行尾', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Grep"
        args={{ pattern: 'getInstallTodoListByTerrCodeV2', path: 'src' }}
        result="1 match"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const param = screen.getByText('getInstallTodoListByTerrCodeV2');

    expect(trigger?.className).toContain('inline-flex');
    expect(trigger?.className).toContain('max-w-full');
    expect(trigger?.className.split(/\s+/)).not.toContain('w-full');
    expect(param.className).toContain('truncate');
    expect(param.className).not.toContain('flex-1');
  });

  it('编辑类工具把 diff 统计紧跟在文件路径后面', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Edit"
        args={{
          file_path: 'src/main/java/InstallListPage.java',
          old_string: 'foo',
          new_string: 'bar',
        }}
        result="ok"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const label = container.querySelector('[data-slot="tool-fallback-trigger-label"]');
    const path = screen.getByText('InstallListPage.java');
    const chevron = container.querySelector('[data-slot="tool-fallback-trigger-chevron"]');

    expect(trigger?.className.split(/\s+/)).not.toContain('w-full');
    expect(label?.className).not.toContain('flex-1');
    expect(path.className).not.toContain('flex-1');
    expect(label?.textContent).toMatch(/\+\d+/);
    expect(label?.textContent).toMatch(/-\d+/);
    expect(path.compareDocumentPosition(chevron!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('终端的长参数仍可在最大宽度内截断展示', () => {
    const command = 'cd /d/project/ai-code/codeMUX && git diff --stat HEAD | head -40 && npm run build -- --mode production';
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Bash"
        args={{ command }}
        result="done"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const param = screen.getByText(command);

    expect(trigger?.className).toContain('max-w-full');
    expect(param.className).toContain('truncate');
    expect(param.className).not.toContain('flex-1');
  });

  it('终端展开后以终端面板展示命令和输出，不再拆成参数 JSON 和结果标签', () => {
    const command = 'cd /d/project/ai-code/codeMUX && git diff --stat HEAD | head -40';
    const output = [
      'src/components/agent/assistant-ui/CodeMuxMessageParts.tsx | 10 +++-',
      'src/components/assistant-ui/tool-fallback.tsx           |  4 +',
      ' 2 files changed, 12 insertions(+), 2 deletions(-)',
    ].join('\n');

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="shell_command"
        args={{ command, timeout_ms: 10000, workdir: 'D:\\project\\ai-code\\codeMUX' }}
        result={output}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    const commandLine = container.querySelector('[data-slot="tool-fallback-command-line"]');
    const outputBlock = container.querySelector('[data-slot="tool-fallback-command-output"]');
    const contentBody = container.querySelector('[data-slot="tool-fallback-content"]')?.firstElementChild;

    expect(panel?.textContent).toContain(`$ ${command}`);
    expect(panel?.textContent).toContain('CodeMuxMessageParts.tsx');
    expect(panel?.textContent).toContain('2 files changed');
    expect(panel?.className).toContain('font-mono');
    expect(panel?.className).toContain('overflow-hidden');
    expect(panel?.className).not.toMatch(/overflow-(?:y-)?auto/);
    expect(commandLine?.className).toContain('wrap-anywhere');
    expect(commandLine?.className).not.toMatch(/overflow-(?:y-)?auto/);
    expect(outputBlock?.className).toContain('overflow-y-auto');
    expect(outputBlock?.className).toContain('overflow-x-hidden');
    expect(outputBlock?.className).toContain('whitespace-pre-wrap');
    expect(outputBlock?.className).toContain('wrap-anywhere');
    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(contentBody?.className).not.toContain('max-h-40');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(container.textContent).not.toContain('结果：');
    expect(container.textContent).not.toContain('"timeout_ms"');
    expect(container.textContent).not.toContain('"workdir"');
  });
  it('Codex unified exec 的 exec_command 走同一条终端面板：命令在标题右侧，展开是命令 + 输出', () => {
    const command = 'Get-Content -Raw src/components/agent/toolHeaderSummary.ts';
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="exec_command"
        args={{ cmd: command, max_output_tokens: 30000, workdir: 'D:\\project\\ai-code\\codeMUX' }}
        result={{ output: 'export const SHELL = 1;\n', session_id: 16043 }}
      />,
    );

    const param = screen.getByText(command);
    expect(param.className).toContain('truncate');
    expect(container.textContent).not.toContain('"workdir"');

    fireEvent.click(within(container).getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    expect(panel?.textContent).toContain(`$ ${command}`);
    expect(panel?.textContent).toContain('export const SHELL = 1;');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.textContent).not.toContain('结果：');
  });

  it('Codex exec 把 JS 输入当命令展示：头部摘要 + 终端面板', () => {
    const jsInput = 'const r = await tools.exec_command({ cmd: "git status --short" }); r.output';
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="exec"
        args={{ input: jsInput }}
        result={{ output: ' M src/App.tsx', session_id: 7 }}
      />,
    );

    expect(screen.getByText(jsInput)).toBeTruthy();

    fireEvent.click(within(container).getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    expect(panel?.textContent).toContain(`$ ${jsInput}`);
    expect(panel?.textContent).toContain('M src/App.tsx');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
  });

  it('Codex write_stdin 只映射工具名：中文名做动作词，参数仍按 JSON 展开', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="write_stdin"
        args={{ chars: '', session_id: 16043, yield_time_ms: 1000 }}
        result="ok"
      />,
    );

    const trigger = screen.getByRole('button', { name: /向命令输入/ });
    expect(container.querySelector('[data-slot="tool-fallback-command"]')).toBeNull();

    fireEvent.click(trigger);

    expect(container.querySelector('[data-slot="tool-fallback-command"]')).toBeNull();
    expect(container.textContent).toContain('"session_id"');
  });
  it('Codex exec 的 input_text 结果块被拍平成可读输出，不再渲染 JSON 转储', () => {
    const jsInput = 'const r = await tools.exec_command({cmd:"npx vitest run",workdir:"D:/project/ai-code/codeMUX"}); text(JSON.stringify(r));';
    // Codex unified exec 的结果：文本块数组，块内是「JSON 信封 + 内层 output」。
    const frames = [
      { text: 'Script completed\nWall time 10.4 seconds\noutput:\n', type: 'input_text' },
      {
        text: JSON.stringify({
          chunk_id: '0c3d9a',
          wall_time_seconds: 10.0056401,
          session_id: 90398,
          original_token_count: 11,
          output: '\n RUN  v4.1.8 D:/project/ai-code/codeMUX\n\n\n',
        }),
        type: 'input_text',
      },
    ];

    // 侧车把内容块整份 JSON.stringify 过来（历史落盘同形）；原始数组形状也要认。
    for (const result of [JSON.stringify(frames), frames]) {
      const { container, unmount } = renderWithTooltip(
        <CodeMuxToolCallMessagePart toolName="exec" args={{ input: jsInput }} result={result} />,
      );

      fireEvent.click(within(container).getByRole('button', { name: /终端/ }));

      const panel = container.querySelector('[data-slot="tool-fallback-command"]');
      expect(panel?.textContent).toContain('Script completed');
      expect(panel?.textContent).toContain('RUN  v4.1.8 D:/project/ai-code/codeMUX');
      expect(panel?.textContent).not.toContain('chunk_id');
      expect(panel?.textContent).not.toContain('input_text');
      expect(panel?.textContent).not.toContain('"type"');
      unmount();
    }
  });

  it('非终端工具（write_stdin）的结果块同样拍平文本块，不渲染 JSON 转储', () => {
    const frames = [
      { text: 'Wall time 0.4 seconds\noutput:\n', type: 'input_text' },
      {
        text: JSON.stringify({ chunk_id: 'a1b2', session_id: 90398, output: 'y\n' }),
        type: 'input_text',
      },
    ];

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="write_stdin"
        args={{ chars: 'y\n', session_id: 90398, yield_time_ms: 1000 }}
        result={JSON.stringify(frames)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /向命令输入/ }));

    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');
    expect(resultBlock?.textContent).toContain('Wall time 0.4 seconds');
    expect(resultBlock?.textContent).not.toContain('input_text');
    expect(resultBlock?.textContent).not.toContain('chunk_id');
  });

  it('pi 落盘前的工具结果按 content 文本块展开，不渲染成 JSON 转储', () => {
    const command = 'cd /tmp && head -c 500 comments.txt';
    // 实时投影已在 sidecar 拍平；这里覆盖**升级前落盘**的
    // `{"content":[{"type":"text",...}]}` 形状（session 历史里仍是转储串）。
    const legacy = JSON.stringify({
      content: [{ type: 'text', text: ' = <decode err>\n = <decode err>' }],
      details: {},
    });

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart toolName="Bash" args={{ command }} result={legacy} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /运行|终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    expect(panel?.textContent).toContain('<decode err>');
    expect(panel?.textContent).not.toContain('"type": "text"');
    expect(panel?.textContent).not.toContain('"content"');
  });

  it('Bash 展开面板展示真实命令而不是 header 里的 description', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Bash"
        args={{ description: 'Check git diff', command: 'git diff --stat HEAD' }}
        result="1 file changed, 4 insertions(+)"
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    expect(panel?.textContent).toContain('$ git diff --stat HEAD');
    expect(panel?.textContent).toContain('1 file changed, 4 insertions(+)');
    expect(panel?.textContent).not.toContain('Check git diff');
  });

  it('在 AI 消息中将询问用户工具渲染为问题回单卡片', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="question"
        toolCallId="question-message-1"
        sessionId="session-1"
        args={{
          questions: [{
            header: '技术栈',
            question: '你主要使用哪些技术栈？',
            multiple: true,
            options: [{ label: 'TypeScript' }, { label: 'Rust' }],
          }, {
            header: '周末',
            question: '周末你喜欢做什么？',
            options: [{ label: '写代码' }],
          }],
        }}
        result={JSON.stringify({ answers: [['TypeScript', 'Rust'], ['写代码']] })}
      />,
    );

    const trigger = screen.getByRole('button', { name: /询问用户/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    expect(screen.getByText('技术栈')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('Rust')).toBeTruthy();
    expect(screen.getByText('多选')).toBeTruthy();
    expect(screen.getByText('2 已回答')).toBeTruthy();
    expect(screen.getByText('你主要使用哪些技术栈？')).toBeTruthy();
    expect(screen.getByRole('button', { name: /下一个/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /下一个/ }));
    expect(screen.getByText('周末')).toBeTruthy();
    expect(screen.getByText('写代码')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-fallback-root"]')).toBeTruthy();
    expect(container.querySelector('[data-compact="true"]')).toBeTruthy();
  });

  it('将未回答的询问工具渲染为不可操作的工具预览', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="AskUserQuestion"
        toolCallId="pending-question-message-1"
        sessionId="session-1"
        args={{
          questions: [{
            header: '编程习惯',
            question: '你的日常编程习惯有哪些?(可多选)',
            multiple: true,
            options: [{ label: '自动化测试' }, { label: '代码审查' }],
          }],
        }}
      />,
    );

    expect(container.textContent).toContain('等待用户回答');
    expect(container.textContent).not.toContain('自动化测试');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('点击 ExitPlanMode 的 planFilePath 后在右侧计划标签中预览 plan 快照，展开区不重复展示整段 plan', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="ExitPlanMode"
        args={{
          plan: '# 优化 ExitPlanMode\n\n- 这段计划内容不应该塞进工具展开参数里',
          planFilePath: 'docs/superpowers/plans/exit-plan.md',
        }}
        result="No response requested."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /预览计划 docs\/superpowers\/plans\/exit-plan\.md/ }));

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [
        expect.objectContaining({
          kind: 'plan',
          planFilePath: 'docs/superpowers/plans/exit-plan.md',
          planContent: '# 优化 ExitPlanMode\n\n- 这段计划内容不应该塞进工具展开参数里',
        }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /退出计划模式/ }));

    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    expect(argsBlock?.textContent).not.toContain('"plan"');
    expect(argsBlock?.textContent).not.toContain('这段计划内容不应该塞进工具展开参数里');
    expect(argsBlock?.textContent).toContain('"planFilePath"');
  });

  it('写入文件工具展开时只让 diff 区滚动，避免外层和内层出现双滚动条', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Write"
        args={{
          file_path: 'snappy-splashing-lobster.md',
          content: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
        }}
        result="File written successfully"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /写入/ }));

    const content = container.querySelector('[data-slot="tool-fallback-content"]');
    const contentBody = content?.firstElementChild;
    const diffViewer = container.querySelector('[data-slot="diff-viewer"]');

    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(contentBody?.className).not.toContain('max-h-40');
    expect(diffViewer?.className).toContain('overflow-auto');
  });

  it('描述符存在时委派工具行不再渲染，入口由委派卡片的节点卡承担', () => {
    useSubagentStore.setState({
      sessions: {
        'session-1': {
          order: ['toolu_1'],
          descriptors: {
            toolu_1: {
              subagentId: 'toolu_1',
              provider: 'claude',
              title: 'Explore',
              description: '检查消息渲染',
              status: 'running',
              toolCallId: 'toolu_1',
              subtitle: null,
              updatedAt: 0,
            },
          },
          events: { toolu_1: [] },
          seenEventIds: {},
        },
      },
    });

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Task"
        toolCallId="toolu_1"
        sessionId="session-1"
        args={{ description: '检查消息渲染', prompt: '内部提示词' }}
        result="Async agent launched successfully"
      />,
    );

    // 能按 toolCallId 找到描述符 = 这是一次真正的委派：委派卡片取代工具行，
    // 这里什么都不画（打开预览的入口是卡片的节点卡，见 subagent-activity.test.tsx）。
    expect(container.querySelector('[data-slot="tool-fallback-root"]')).toBeNull();
    expect(container.querySelector('[data-slot="subagent-preview-chip"]')).toBeNull();
    expect(useSidePanelStore.getState().isOpen).toBe(false);
  });
});

describe('CodeMuxDataMessagePart', () => {
  beforeEach(() => {
    cleanup();
    usePreviewStore.setState({
      treeRoot: [{
        name: 'docs',
        path: 'D:/project/ai-code/codeMUX/docs',
        isDir: true,
        children: [
          {
            name: 'feature.md',
            path: 'D:/project/ai-code/codeMUX/docs/feature.md',
            isDir: false,
          },
        ],
      }],
      treeRootPath: 'D:/project/ai-code/codeMUX',
      projectPath: 'D:/project/ai-code/codeMUX',
    });
  });

  it('在产物卡片上方仅列出正文里提到的 Markdown 文件', () => {
    renderWithTooltip(
      <CodeMuxDataMessagePart
        name="codemux-event"
        messageText="已写入 `docs/feature.md`"
        data={{
          eventKind: 'session_summary',
          event: {
            kind: 'session_summary',
            data: {
              type: 'system',
              subtype: 'session_summary',
              diffs: [{ file: 'src/App.tsx', additions: 1, deletions: 0 }],
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('referenced-markdown-files')).toBeTruthy();
    expect(screen.getByText('feature.md')).toBeTruthy();
    expect(screen.getByText('文档 · MD')).toBeTruthy();
    expect(screen.getByText('1 个文件已更改')).toBeTruthy();
  });

  it('正文未提到 md 文件时不展示 Markdown 列表，即使改动产物里有 md', () => {
    renderWithTooltip(
      <CodeMuxDataMessagePart
        name="codemux-event"
        messageText="已按 spec 完成修订。"
        data={{
          eventKind: 'session_summary',
          event: {
            kind: 'session_summary',
            data: {
              type: 'system',
              subtype: 'session_summary',
              diffs: [
                { file: 'MEMORY.md', additions: 1, deletions: 0 },
                { file: 'docs/design.md', additions: 2, deletions: 1 },
              ],
            },
          },
        }}
      />,
    );

    expect(screen.queryByTestId('referenced-markdown-files')).toBeNull();
    expect(screen.getByText('2 个文件已更改')).toBeTruthy();
  });

  it('把 Claude 空闲超时的 sidecar 错误展示成中文提示', () => {
    render(
      <CodeMuxDataMessagePart
        name="codemux-event"
        data={{
          eventKind: 'error',
          event: {
            kind: 'error',
            data: {
              type: 'sidecar_error',
              error: 'Query timed out: no message received for 300s (after msg #412)\nError: Query timed out: no message received for 300s (after msg #412)\n    at Timeout._onTimeout (file:///D:/project/ai-code/codeMUX/apps/sidecar/dist/index.js:692:32)',
            },
          },
        }}
      />,
    );

    expect(screen.getByText('引擎空闲超时（300 秒无响应），请重新发送消息继续')).toBeTruthy();
    expect(screen.queryByText(/Timeout\._onTimeout/)).toBeNull();
    expect(screen.queryByText(/Query timed out/)).toBeNull();
  });
});

describe('getKnownSidecarErrorDisplay', () => {
  it('maps configured Claude idle timeouts to engine idle copy', () => {
    expect(getKnownSidecarErrorDisplay('Query timed out: no message received for 120s (after msg #9)')).toBe(
      '引擎空闲超时（120 秒无响应），请重新发送消息继续',
    );
  });

  it('keeps real user-input timeout copy distinct from idle timeout', () => {
    expect(getKnownSidecarErrorDisplay('等待用户回复超时，请重新发送消息继续')).toBe(
      '等待用户回复超时，请重新发送消息继续',
    );
  });

  it('maps Codex idle timeout errors', () => {
    expect(getKnownSidecarErrorDisplay('Turn idle timeout: no progress events received')).toBe(
      '引擎空闲超时（无进展事件），请重新发送消息继续',
    );
  });

  it('maps OpenCode idle timeout errors', () => {
    expect(getKnownSidecarErrorDisplay('No progress events for 300000ms; turn idle timed out')).toBe(
      '引擎空闲超时（300 秒无响应），请重新发送消息继续',
    );
  });
});
