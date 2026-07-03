// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { getStreamStatusDisplay } from './CodeMuxMessageParts';
import { CodeMuxToolCallMessagePart } from './CodeMuxMessageParts';

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
});
