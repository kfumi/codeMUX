// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { getStreamStatusDisplay } from './CodeMuxMessageParts';
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
    expect(display.text).toContain('协作模式已阻止');
    expect(display.text).toContain('request_user_input_blocked_in_default_mode');
    expect(display.text).not.toContain('连接断开');
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
  });

  it('只展示子智能体工具消息本身，不再追加子智能体详情面板', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Agent"
        args={{ description: '检查消息渲染', prompt: '内部子智能体提示词\n\n请只返回结论' }}
        result="子智能体最终结果：**已完成**"
      />,
    );

    expect(screen.queryByText(/内部子智能体提示词/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /子智能体/ }));

    const argsText = screen.getByText(/内部子智能体提示词/);
    const resultText = screen.getByText(/子智能体最终结果：/);

    expect(argsText.closest('[data-slot="tool-fallback-args"]')?.className).toContain('justify-end');
    expect(resultText.closest('[data-slot="tool-fallback-result"]')?.className).toContain('justify-start');
    expect(argsText.closest('[data-slot="tool-fallback-args"]')?.textContent).toBe('内部子智能体提示词\n\n请只返回结论');
    expect(screen.queryByText(/"prompt"/)).toBeNull();
    expect(screen.queryByText(/"description"/)).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"] .aui-md strong')?.textContent).toBe('已完成');
  });

  it('普通工具参数和结果保持原始详情样式，不使用子智能体对话式气泡或 Markdown 渲染', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="shell_command"
        args={{ command: 'echo "**not bold**"' }}
        result="结果包含 **not bold**"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /运行命令/ }));

    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');

    expect(argsBlock?.className).not.toContain('justify-end');
    expect(resultBlock?.className).not.toContain('justify-start');
    expect(resultBlock?.querySelector('strong')).toBeNull();
    expect(resultBlock?.textContent).toContain('结果包含 **not bold**');
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
});

describe('CodeMuxDataMessagePart', () => {
  it('把 askUserQuestion 等待超时的 sidecar 错误展示成中文提示', () => {
    render(
      <CodeMuxDataMessagePart
        name="codemux-event"
        data={{
          eventKind: 'error',
          event: {
            kind: 'error',
            data: {
              type: 'sidecar_error',
              error: 'Query timed out: no message received for 300s (after msg #412)\nError: Query timed out: no message received for 300s (after msg #412)\n    at Timeout._onTimeout (file:///D:/project/ai-code/codeMUX/src-tauri/sidecar/dist/index.js:692:32)',
            },
          },
        }}
      />,
    );

    expect(screen.getByText('等待用户回复超时，请重新发送消息继续')).toBeTruthy();
    expect(screen.queryByText(/Timeout\._onTimeout/)).toBeNull();
    expect(screen.queryByText(/Query timed out/)).toBeNull();
  });
});
