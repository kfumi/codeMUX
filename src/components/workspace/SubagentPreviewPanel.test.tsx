// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useSubagentStore } from '@/stores/subagentStore';
import { SubagentPreviewPanel } from './SubagentPreviewPanel';

function renderPanel(sessionId = 'session-1', subagentId = 'toolu_1') {
  return render(
    <TooltipProvider>
      <SubagentPreviewPanel sessionId={sessionId} subagentId={subagentId} />
    </TooltipProvider>,
  );
}

function seedStore(options: {
  status: 'running' | 'completed';
  events?: Array<Record<string, unknown>>;
}) {
  useSubagentStore.setState({
    sessions: {
      'session-1': {
        order: ['toolu_1'],
        descriptors: {
          toolu_1: {
            subagentId: 'toolu_1',
            provider: 'claude',
            title: 'Explore',
            description: '探索前端技术栈',
            status: options.status,
            toolCallId: 'toolu_1',
            subtitle: 'Reading src/main.tsx',
            updatedAt: 0,
          },
        },
        events: { toolu_1: options.events ?? [] },
        seenEventIds: { toolu_1: new Set((options.events ?? []).map((event) => String(event.event_id))) },
      },
    },
  });
}

describe('SubagentPreviewPanel', () => {
  beforeEach(() => {
    useSubagentStore.setState({ sessions: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('running 且尚无内容时显示启动中 loading', () => {
    seedStore({ status: 'running' });

    renderPanel();

    expect(screen.getByText('子智能体启动中…')).toBeTruthy();
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('无记录且非运行时显示空态文案', () => {
    seedStore({ status: 'completed' });

    renderPanel();

    expect(screen.getByText('没有可显示的子智能体记录')).toBeTruthy();
  });

  it('运行中在时间线底部显示运行中指示', () => {
    seedStore({
      status: 'running',
      events: [
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '正在检查 package.json' }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });

    renderPanel();

    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(screen.getByText(/正在检查 package\.json/)).toBeTruthy();
  });

  it('消息 footer 提供复制按钮并可复制文本', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '汇总内容' }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    const footer = container.querySelector('[data-message-footer]');
    expect(footer).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('汇总内容');
    });
  });
});
