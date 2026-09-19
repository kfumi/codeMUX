// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_RUN_STEP_INDENT } from '@/components/assistant-ui/activity-run';
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

/** 段内步骤行的缩进容器：段头让位给整轮「已处理」开关的段不缩进，其余段带 `ACTIVITY_RUN_STEP_INDENT`。 */
function stepIndentContainer(element: Element): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement;
  while (node && !node.className.includes('group/message-row')) {
    if (node.className.includes('gap-[3px]')) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
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

    // 思考是一个只有 1 步的处理段：段头先渲染，步骤行收起时不渲染。
    expect(container.querySelector('[data-slot="reasoning-trigger"]')).toBeNull();
    const runTrigger = container.querySelector('[data-slot="activity-run-trigger"]') as HTMLElement;
    expect(runTrigger).toBeTruthy();
    expect(runTrigger.getAttribute('aria-label')).toMatch(/^已思考/);

    fireEvent.click(runTrigger);

    const reasoningTrigger = container.querySelector('[data-slot="reasoning-trigger"]') as HTMLElement;
    expect(reasoningTrigger).toBeTruthy();
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

  it('工具调用使用主会话同一套工具卡片', () => {
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
          type: 'assistant_message',
          content: [{ type: 'text', text: '已搜索' }],
          event_id: 'e2',
          timestamp: '2026-08-29T05:47:22.000Z',
        },
      ],
    });

    const { container } = renderPanel();

    // 段收起时工具行不渲染：先展开段头（工具卡仍是主会话那一套）。
    const runTrigger = container.querySelector('[data-slot="activity-run-trigger"]') as HTMLElement;
    expect(runTrigger).toBeTruthy();
    fireEvent.click(runTrigger);

    expect(screen.getByRole('button', { name: /搜索文本/ })).toBeTruthy();
  });

  it('连续工具调用收进同一处理段，展开后才看到各工具卡片', () => {
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

    // 两个连续的工具调用合成一段：段头只有一条，步骤行收起时不渲染。
    const runTriggers = container.querySelectorAll('[data-slot="activity-run-trigger"]');
    expect(runTriggers).toHaveLength(1);
    expect(runTriggers[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-slot="tool-fallback-trigger"]')).toHaveLength(0);

    fireEvent.click(runTriggers[0]!);

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

  it('紧凑输出开启时中间过程收成已处理，展开后才看到过程', () => {
    useSettingsStore.setState({ config: compactConfig(true) });
    seedStore({
      status: 'completed',
      events: completedProcessEvents,
    });

    const { container } = renderPanel();

    expect(screen.getByText('最终汇总')).toBeTruthy();
    expect(screen.queryByText('中间过程说明')).toBeNull();
    expect(screen.queryByRole('button', { name: /搜索文本/ })).toBeNull();
    // 整轮收起：工具段的段头与步骤行都不渲染。
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);

    const toggle = screen.getByRole('button', { name: '展开AI过程' });
    expect(toggle.textContent).toContain('本轮处理');
    expect(toggle.textContent).toContain('6s');

    fireEvent.click(toggle);

    expect(screen.getByText('中间过程说明')).toBeTruthy();
    // 工具段自己有段头、且已经结束：整轮展开后它照常默认收起，点段头后才渲染工具步骤行。
    const runTrigger = container.querySelector('[data-slot="activity-run-trigger"]') as HTMLElement;
    expect(runTrigger).toBeTruthy();
    expect(runTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /搜索文本/ })).toBeNull();

    fireEvent.click(runTrigger);

    expect(runTrigger.getAttribute('aria-expanded')).toBe('true');
    const toolStep = screen.getByRole('button', { name: /搜索文本/ });
    // 有可见段头的段：步骤行缩进到组头下面。
    expect(stepIndentContainer(toolStep)?.className).toContain(ACTIVITY_RUN_STEP_INDENT);
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
