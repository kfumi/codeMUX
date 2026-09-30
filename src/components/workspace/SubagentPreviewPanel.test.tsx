// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useAgentStore } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSubagentStore } from '@/stores/subagentStore';
import type { AppConfig } from '@/types/provider';
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

const compactConfig = (enabled: boolean): AppConfig => ({
  model_providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: {},
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
  compact_ai_output: enabled,
  default_open_target: 'file_explorer',
  notifications: { system_enabled: true, sound_enabled: false, sound: 'ding' },
});

const completedProcessEvents = [
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
];

describe('SubagentPreviewPanel', () => {
  beforeEach(() => {
    useSubagentStore.setState({ sessions: {} });
    useSettingsStore.setState({ config: compactConfig(false) });
  });

  afterEach(() => {
    useSettingsStore.setState({ config: compactConfig(false) });
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

  it('运行中在表头显示状态胶囊与实时计时', () => {
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

    const { container } = renderPanel();

    // 状态与时长都收在表头：胶囊说状态，计时器自首条事件起算、每秒推进。
    expect(container.querySelector('[data-slot="subagent-panel-status"]')?.textContent).toBe('运行中');
    expect(container.querySelector('[data-slot="subagent-panel-duration"]')?.textContent).toMatch(/[0-9]+[dhms]/);
    // 不再展示最新活动 subtitle。
    expect(screen.queryByText(/Reading src/)).toBeNull();
    expect(screen.getByText(/正在检查 package/)).toBeTruthy();
  });

  it('表头显示智能体名、事件里的模型名、状态胶囊与整段时长', () => {
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '先列目录' }],
          model: 'mimo-v2.5-free',
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:19.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '汇总完成' }],
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:25.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // 第一行是智能体名（`title`），任务描述留给正文。
    expect(container.querySelector('[data-slot="subagent-panel-title"]')?.textContent).toBe('Explore');
    const model = container.querySelector('[data-slot="subagent-panel-model"]');
    expect(model?.getAttribute('data-model-source')).toBe('event');
    expect(model?.textContent).toBe('mimo-v2.5-free');
    expect(container.querySelector('[data-slot="subagent-panel-status"]')?.textContent).toBe('已完成');
    // 终态时长取首末事件之差：静态数字，不挂计时器。
    expect(container.querySelector('[data-slot="subagent-panel-duration"]')?.textContent).toBe('6s');
  });

  it('事件里没有模型名时表头退回 provider', () => {
    seedStore({ status: 'completed', events: completedProcessEvents });

    const { container } = renderPanel();

    const model = container.querySelector('[data-slot="subagent-panel-model"]');
    expect(model?.getAttribute('data-model-source')).toBe('provider');
    expect(model?.textContent).toBe('claude');
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
    const promptText = screen.getAllByText(/探索前端技术栈/).find((el) =>
      el.closest('[data-user-message-bubble="true"]'),
    );
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

    const { container } = renderPanel();

    // 思考按顺序平铺成一行收起的单行摘要（没有段组头），点开后才是正文。
    const reasoningTrigger = container.querySelector('[data-slot="reasoning-trigger"]') as HTMLElement;
    expect(reasoningTrigger).toBeTruthy();
    expect(reasoningTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(reasoningTrigger.textContent).toContain('思考');
    // 收起时只显示单行摘要，思考正文不当作普通文本铺开。
    expect(reasoningTrigger.textContent).toContain('先看目录结构');
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();

    fireEvent.click(reasoningTrigger);

    expect(container.querySelector('[data-slot="activity-step-body"]')?.textContent).toContain('先看目录结构');
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

  it('节减 footer 不含耗时、分叉和排查', () => {
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

    renderPanel();

    expect(screen.queryByText(/耗时/)).toBeNull();
    expect(screen.queryByRole('button', { name: '从此回复创建分支' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制排查问题提示词' })).toBeNull();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  });

  it('助手正文走 Markdown 而不是纯文本', () => {
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'assistant_message',
          content: [{
            type: 'text',
            text: '结论见 **package.json** 与 `src/App.tsx`\n\n```ts\nconst ready = true;\n```',
          }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    expect(container.querySelector('.aui-md')).toBeTruthy();
    expect(screen.getByText('package.json')).toBeTruthy();
    expect(container.textContent).not.toContain('**package.json**');
    expect(container.textContent).not.toContain('```ts');
    expect(container.querySelector('pre, code')).toBeTruthy();
  });

  /**
   * 实时尾部：daemon 为了历史可回放把每条 delta 都落了库，而消息投影只认已提交的那
   * 一半。没有尾部时子智能体正文要等 `assistant_message` 信封到达才整段出现。
   */
  describe('未提交正文尾部', () => {
    const prompt = {
      type: 'user_message',
      content: '探索前端技术栈',
      event_id: 'e0',
      timestamp: '2026-08-29T05:47:19.000Z',
    };

    it('运行中把已到达但未提交的正文显示出来', () => {
      seedStore({
        status: 'running',
        events: [
          prompt,
          { type: 'content_started', index: 0, content_kind: 'text', event_id: 'd0', timestamp: '2026-08-29T05:47:20.000Z' },
          { type: 'text_delta', index: 0, text: '结论：', event_id: 'd1', timestamp: '2026-08-29T05:47:20.100Z' },
          { type: 'text_delta', index: 0, text: '用 Vite。', event_id: 'd2', timestamp: '2026-08-29T05:47:20.200Z' },
        ],
      });

      const { container } = renderPanel();

      expect(container.querySelector('[data-slot="subagent-live-tail"]')).toBeTruthy();
      expect(container.textContent).toContain('结论：');
      expect(container.textContent).toContain('用 Vite。');
    });

    it('信封到达后尾部消失，同一段文字不显示两次', () => {
      seedStore({
        status: 'running',
        events: [
          prompt,
          { type: 'content_started', index: 0, content_kind: 'text', event_id: 'd0', timestamp: '2026-08-29T05:47:20.000Z' },
          { type: 'text_delta', index: 0, text: '结论：用 Vite。', event_id: 'd1', timestamp: '2026-08-29T05:47:20.100Z' },
          { type: 'content_finished', index: 0, event_id: 'd2', timestamp: '2026-08-29T05:47:20.200Z' },
          {
            type: 'assistant_message',
            content: [{ type: 'text', text: '结论：用 Vite。' }],
            event_id: 'e1',
            timestamp: '2026-08-29T05:47:20.300Z',
          },
        ],
      });

      const { container } = renderPanel();

      expect(container.querySelector('[data-slot="subagent-live-tail"]')).toBeNull();
      const occurrences = (container.textContent ?? '').split('结论：用 Vite。').length - 1;
      expect(occurrences).toBe(1);
    });

    it('终态但仍有未提交 delta 时照样显示（信封与终态之间有竞态，不能把正文弄丢）', () => {
      seedStore({
        status: 'completed',
        events: [
          prompt,
          { type: 'text_delta', index: 0, text: '收尾正文', event_id: 'd1', timestamp: '2026-08-29T05:47:20.100Z' },
        ],
      });

      const { container } = renderPanel();

      expect(container.querySelector('[data-slot="subagent-live-tail"]')).toBeTruthy();
      expect(container.textContent).toContain('收尾正文');
    });

    it('信封已到、尾部为空时不显示尾部', () => {
      seedStore({
        status: 'completed',
        events: [
          prompt,
          { type: 'text_delta', index: 0, text: '收尾正文', event_id: 'd1', timestamp: '2026-08-29T05:47:20.100Z' },
          {
            type: 'assistant_message',
            content: [{ type: 'text', text: '收尾正文' }],
            event_id: 'e1',
            timestamp: '2026-08-29T05:47:20.300Z',
          },
        ],
      });

      const { container } = renderPanel();

      expect(container.querySelector('[data-slot="subagent-live-tail"]')).toBeNull();
    });

    it('思考增量走思考折叠组件，不混进正文', () => {
      seedStore({
        status: 'running',
        events: [
          prompt,
          { type: 'reasoning_delta', index: 0, text: '先看入口文件', event_id: 'd0', timestamp: '2026-08-29T05:47:20.000Z' },
        ],
      });

      const { container } = renderPanel();

      const tail = container.querySelector('[data-slot="subagent-live-tail"]');
      expect(tail).toBeTruthy();
      expect(tail?.querySelector('[data-streaming-reasoning="true"]')).toBeTruthy();
      expect(tail?.querySelector('[data-streaming-text="markdown"]')).toBeNull();
    });
  });

  it('工具调用使用主会话同一套工具卡片', () => {    seedStore({
      status: 'completed',
      events: [
        {
          type: 'tool_started',
          tool_use_id: 'c1',
          name: 'Grep',
          input: { pattern: 'AgentPanel' },
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:21.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '已搜索' }],
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:22.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // 没有段组头：工具卡按顺序直接平铺（工具卡仍是主会话那一套）。
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /搜索文本/ })).toBeTruthy();
  });

  it('连续工具调用按源码顺序平铺成各工具卡片', () => {
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'tool_started',
          tool_use_id: 'c1',
          name: 'Grep',
          input: { pattern: 'AgentPanel' },
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:21.000Z',
        },
        {
          type: 'tool_started',
          tool_use_id: 'c2',
          name: 'Read',
          input: { file_path: 'src/App.tsx' },
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:22.000Z',
        },
        {
          type: 'tool_finished',
          tool_use_id: 'c1',
          content: 'matches',
          is_error: false,
          event_id: 'e2b',
          timestamp: '2026-08-29T05:47:22.100Z',
        },
        {
          type: 'tool_finished',
          tool_use_id: 'c2',
          content: 'ok',
          is_error: false,
          event_id: 'e2c',
          timestamp: '2026-08-29T05:47:22.200Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '完成' }],
          event_id: 'e3',
          timestamp: '2026-08-29T05:47:23.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // 没有段组头：两个工具卡片按源码顺序直接平铺。
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);

    const toolTriggers = Array.from(container.querySelectorAll('[data-slot="tool-fallback-trigger"]'));
    expect(toolTriggers).toHaveLength(2);
    expect(toolTriggers[0]!.getAttribute('aria-label')).toContain('搜索');
    expect(toolTriggers[1]!.getAttribute('aria-label')).toContain('读取');
    expect(toolTriggers[0]!.textContent).toContain('AgentPanel');
    expect(toolTriggers[1]!.textContent).toContain('App.tsx');
  });

  it('超长任务提示默认折叠，点击查看更多后展开', () => {
    const prompt = Array.from({ length: 20 }, (_, index) => `第${index + 1}行任务说明`).join('\n');
    seedStore({
      status: 'completed',
      events: [
        {
          type: 'user_message',
          content: prompt,
          event_id: 'e0',
          timestamp: '2026-08-29T05:47:19.000Z',
        },
      ],
    });

    const { container } = renderPanel();
    const promptCard = container.querySelector('[data-user-message-bubble="true"]');

    expect(promptCard?.className).toContain('max-h-80');
    expect(screen.getByRole('button', { name: '查看更多' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看更多' }));

    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse.querySelector('.lucide-chevron-up')).toBeTruthy();
    expect(promptCard?.className).not.toContain('max-h-80');
  });

  it('上翻后显示回到底部按钮', async () => {
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
    const viewport = container.querySelector('[data-testid="subagent-viewport"]') as HTMLElement;
    expect(viewport).toBeTruthy();

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy();
    });
  });

  it('内容增高且未上翻时贴底', async () => {
    seedStore({
      status: 'running',
      events: [
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '第一段' }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });

    const { container } = renderPanel();
    const viewport = container.querySelector('[data-testid="subagent-viewport"]') as HTMLElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 144;
    fireEvent.scroll(viewport);

    seedStore({
      status: 'running',
      events: [
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '第一段' }],
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
        {
          type: 'assistant_message',
          content: [{ type: 'text', text: '第二段' }],
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:21.000Z',
        },
      ],
    });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 800 });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(800);
    });
  });

  it('内容列表底部留白让开浮起的回到底部按钮，最后一行不贴面板下边缘', () => {
    seedStore({ status: 'completed', events: completedProcessEvents });

    const { container } = renderPanel();
    const viewport = container.querySelector('[data-testid="subagent-viewport"]') as HTMLElement;

    // 底内边距挂在内容列表上、滚动容器保持对称：空状态的 `h-full` 居中才不会被顶偏。
    expect(viewport.className).toContain('pt-3');
    expect(viewport.className).not.toContain('pb-');
    const list = viewport.firstElementChild as HTMLElement;
    expect(list.className).toContain('space-y-2');
    // 56px（pb-14）> 按钮的 bottom-4 + h-8 = 48px：滚到底时最后一行不会被按钮压住。
    expect(list.className).toContain('pb-14');
  });

  it('紧凑输出开启时中间过程收成已处理，展开后按顺序平铺', () => {
    useSettingsStore.setState({ config: compactConfig(true) });
    seedStore({
      status: 'completed',
      events: completedProcessEvents,
    });

    const { container } = renderPanel();

    expect(screen.getByText('最终汇总')).toBeTruthy();
    expect(screen.queryByText('中间过程说明')).toBeNull();
    expect(screen.queryByRole('button', { name: /搜索文本/ })).toBeNull();
    // 整轮收起：过程行都不渲染，也没有段组头。
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);

    const toggle = screen.getByRole('button', { name: '展开AI过程' });
    expect(toggle.textContent).toContain('已处理');
    expect(toggle.textContent).toContain('1 个步骤');
    expect(toggle.textContent).toContain('6s');

    fireEvent.click(toggle);

    // 展开后过程按源码顺序平铺：中间说明与工具卡直接可见，没有段组头。
    expect(screen.getByText('中间过程说明')).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /搜索文本/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起AI过程' })).toBeTruthy();
  });

  it('紧凑输出开启但子智能体仍在跑时，当前回合不收成已处理', () => {
    useSettingsStore.setState({ config: compactConfig(true) });
    seedStore({
      status: 'running',
      events: completedProcessEvents,
    });

    renderPanel();

    expect(screen.getByText('中间过程说明')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开AI过程' })).toBeNull();
  });

  it('子时间线缺总结时从父会话 Task 工具结果补全正文', () => {
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
          type: 'tool_started',
          tool_use_id: 'c1',
          name: 'Grep',
          input: { pattern: 'react' },
          event_id: 'e1',
          timestamp: '2026-08-29T05:47:20.000Z',
        },
      ],
    });
    useAgentStore.setState({
      events: {
        'session-1': [
          {
            kind: 'tool_result',
            data: {
              type: 'user',
              message: {
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: 'toolu_1',
                  content: JSON.stringify([{ type: 'text', text: '- Status: DONE\n- 前端使用 React + Vite' }]),
                }],
              },
            },
          },
        ],
      },
    });

    renderPanel();

    expect(screen.getByText(/Status: DONE/)).toBeTruthy();
    expect(screen.getByText(/React \+ Vite/)).toBeTruthy();
  });
});
