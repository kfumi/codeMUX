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

  it('中间过程的 assistant 消息不显示 footer，仅回合最后一条显示', () => {
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'user_message',
          content: '探索前端技术栈',
          event_id: 'e0',
          timestamp: '2026-08-29T05:47:19.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '中间过程说明' }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
        {
          type: 'tool_started',
          tool_use_id: 'c1',
          name: 'Grep',
          input: {},
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:21.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '最终汇总' }],
          event_id: 'e3',
          timestamp: '2026-08-29T05:47:25.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // Footer on the task prompt + the turn's final assistant message only.
    const footers = container.querySelectorAll('[data-message-footer]');
    expect(footers).toHaveLength(2);
    const closestRow = (el: HTMLElement): HTMLElement | null => {
      let node: HTMLElement | null = el;
      while (node && !node.className.includes('group/message-row')) {
        node = node.parentElement;
      }
      return node;
    };
    const finalRow = closestRow(screen.getByText(/最终汇总/));
    expect(finalRow?.querySelector('[data-message-footer]')).toBeTruthy();
    const middleRow = closestRow(screen.getByText(/中间过程说明/));
    expect(middleRow?.querySelector('[data-message-footer]')).toBeNull();
    const promptText = screen.getAllByText(/探索前端技术栈/).find((el) => el.tagName === 'P');
    expect(promptText).toBeTruthy();
    expect(closestRow(promptText!)?.querySelector('[data-message-footer]')).toBeTruthy();
  });

  it('运行中时最后一条 assistant 消息不显示 footer，仅任务提示显示', () => {
    seedStore({
      status: 'running',
      events: [
        {
          type: 'user_message',
          content: '探索前端技术栈',
          event_id: 'e0',
          timestamp: '2026-08-29T05:47:19.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '最终汇总' }],
          event_id: 'e3',
          timestamp: '2026-08-29T05:47:25.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // Still running: only the task prompt row carries a footer.
    const footers = container.querySelectorAll('[data-message-footer]');
    expect(footers).toHaveLength(1);
  });

  it('思考内容用思考折叠组件渲染而不是普通文本', () => {
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'assistant_message',
          content: [
            { type: 'thinking', thinking: '先看目录结构', signature: 'sig' },
            { type: 'text', text: '最终汇总' },
          ],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });

    renderPanel();

    expect(screen.getByText('思考')).toBeTruthy();
    // Collapsed by default: the thinking body is not rendered as plain text.
    expect(screen.queryByText(/先看目录结构/)).toBeNull();
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
