// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { TooltipProvider } from '../../ui/tooltip';
import {
  buildAgentInputPayloadFromAppendMessage,
  CodeMuxImageAttachmentAdapter,
  CodeMuxAssistantRuntimeProvider,
  resolveSlashCommand,
} from './CodeMuxAssistantRuntime';
import { CodeMuxThread, buildToolDurationMap } from './CodeMuxThread';

const sessionOneEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session one user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session one assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const sessionTwoEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session two user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-2',
      session_id: 'session-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session two assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const failedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-tool',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'error',
    data: {
      type: 'sidecar_error',
      error: 'Command failed with exit code 1',
    },
  },
];

const timestampOnlyAssistantEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-timestamp-only',
      session_id: 'session-timestamp',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'timestamp only assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const reasoningEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-reasoning',
      session_id: 'session-reasoning',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'thinking through it' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const groupedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'app' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'src/main.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'main' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const directiveUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '/review @src/App.tsx please check this' } },
];

const longUserText = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');

const longUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: longUserText } },
];

const imageOnlyUserEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: {
      content: '',
      attachments: [
        {
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    },
  },
];

const imageAndTextUserEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: {
      content: 'what is in this screenshot?',
      attachments: [
        {
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    },
  },
];

const completedTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'please fix it' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-process',
      session_id: 'session-completed-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am checking files first.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-final',
      session_id: 'session-completed-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Fixed and verified.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-1',
      session_id: 'session-completed-turn',
      duration_ms: 73_000,
      duration_api_ms: 0,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    },
  },
];

const proposedPlanFinalEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '实现一个贪吃蛇程序' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-plan-final',
      session_id: 'session-plan-final',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `计划如下：

<proposed_plan>
# 贪吃蛇浏览器小游戏

## Summary
做一个可以直接运行的浏览器小游戏。

## Key Changes
- 实现游戏循环
</proposed_plan>`,
        }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-plan-final',
      session_id: 'session-plan-final',
      duration_ms: 1000,
      duration_api_ms: 1000,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    },
  },
];

const proposedPlanNonFinalEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-plan-non-final',
      session_id: 'session-plan-non-final',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<proposed_plan>\n# 不应解析\n\n## Summary\n这是中间消息。\n</proposed_plan>',
        }],
      },
      parent_tool_use_id: null,
    },
  },
];

const navigationTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '修复子智能体展示\n需要保持 Codex 风格' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-1-process',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我先检查现有实现。' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-1-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '已按计划完成这次修复，核心路径都接上了：后端新增索引加载，从 Claude 的 subagents/agent-* metadata 建立映射。',
        }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '调整权限审批功能' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-2-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '权限审批入口已经调整完成，按钮状态、禁用态和审核动作都按新的交互逻辑联动。',
        }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '检查未提交变更' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-3-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '未提交变更已经检查完成，当前只包含导航相关文件。' }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '整理展示提示' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-4-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '展示提示已整理为更短的标题和更稳定的摘要。' }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '补充测试覆盖' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-5-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '测试覆盖已经补充，包含悬停、聚焦和点击滚动行为。' }],
      },
      parent_tool_use_id: null,
    },
  },
];

function buildLargeToolHistoryEvents(turnCount: number): AgentMessage[] {
  const events: AgentMessage[] = [];

  for (let index = 0; index < turnCount; index += 1) {
    const toolUseId = `perf-tool-${index}`;
    events.push(
      { kind: 'user', data: { content: `性能测试消息 ${index}` } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-tool-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: 'Read',
              input: { file_path: `src/perf/${index}.tsx`, note: 'x'.repeat(80) },
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: `perf-tool-result-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `result ${index}\n${'result-line\n'.repeat(6)}`,
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-final-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: `### 结果 ${index}\n\n- 项目 A\n- 项目 B\n\n\`\`\`ts\nconst value${index} = ${index};\n\`\`\``,
            }],
          },
          parent_tool_use_id: null,
        },
      },
    );
  }

  return events;
}

const originalScrollTo = HTMLElement.prototype.scrollTo;
const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];

function triggerResize(target: Element, width: number, height = 720) {
  for (const observer of resizeObservers) {
    if (observer.target !== target) {
      continue;
    }

    observer.callback([
      {
        target,
        contentRect: {
          width,
          height,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: height,
          right: width,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry,
    ], {} as ResizeObserver);
  }
}

function Harness({
  sessionId,
  onSend = vi.fn(async () => {}),
}: {
  sessionId: string;
  onSend?: (content: any) => Promise<void>;
}) {
  const content = (
    <CodeMuxAssistantRuntimeProvider
      sessionId={sessionId}
      onSend={onSend}
      onCommand={vi.fn(async () => {})}
    >
      <CodeMuxThread sessionId={sessionId} />
    </CodeMuxAssistantRuntimeProvider>
  );
  const wrapped = <TooltipProvider>{content}</TooltipProvider>;
  return wrapped;
}

describe('CodeMuxAssistantRuntimeProvider', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    class MockResizeObserver {
      private callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        resizeObservers.push({ callback: this.callback, target });
      }

      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    useAgentStore.setState({
      events: {
        'session-1': sessionOneEvents,
        'session-2': sessionTwoEvents,
        'session-tool': failedToolEvents,
        'session-timestamp': timestampOnlyAssistantEvents,
        'session-reasoning': reasoningEvents,
        'session-grouped-tools': groupedToolEvents,
        'session-directives': directiveUserEvents,
        'session-long-user': longUserEvents,
        'session-image-only': imageOnlyUserEvents,
        'session-image-text': imageAndTextUserEvents,
        'session-completed-turn': completedTurnEvents,
        'session-plan-final': proposedPlanFinalEvents,
        'session-plan-non-final': proposedPlanNonFinalEvents,
        'session-nav': navigationTurnEvents,
      },
      eventTimestamps: {
        'session-1': [1, 2],
        'session-2': [3, 4],
        'session-tool': [5, 6],
        'session-timestamp': [Date.parse('2026-06-12T21:40:00+08:00')],
        'session-completed-turn': [
          Date.parse('2026-06-28T10:00:00Z'),
          Date.parse('2026-06-28T10:00:12Z'),
          Date.parse('2026-06-28T10:01:13Z'),
          Date.parse('2026-06-28T10:01:13Z'),
        ],
      },
      isRunning: {},
      error: {},
      mcpRuntimeStatus: {},
      todos: {},
      streamingThinking: {},
      streamingText: {},
      forceStopped: {},
      streamingToolInputs: {},
      streamingToolMeta: {},
      streamingToolIndexMap: {},
      streamedToolUseIds: {},
      changedFiles: {},
      fileOriginals: {},
      acknowledgedFiles: {},
    });

    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [],
        active_provider_id: null,
        agent_defaults: {
          default_agent_kind: 'claude_code',
        },
        agent_configs: {
          claude_code: {
            executable_mode: 'auto',
            resume_sessions: true,
          },
          codex: {
            sdk_mode: 'responses',
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
      },
    }));
    useSidePanelStore.getState().reset();
  });

  afterEach(() => {
    resizeObservers.length = 0;
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: originalScrollTo,
    });
    cleanup();
  });

  it('switches rendered messages when the active session changes', async () => {
    const view = render(<Harness sessionId="session-1" />);

    expect(await screen.findByText('session one assistant')).toBeTruthy();
    expect(screen.queryByText('session two assistant')).toBeNull();

    view.rerender(<Harness sessionId="session-2" />);

    expect(await screen.findByText('session two assistant')).toBeTruthy();
    expect(screen.queryByText('session one assistant')).toBeNull();
  });

  it('renders failed tool calls as errors instead of leaving them running', () => {
    const { container } = render(<Harness sessionId="session-tool" />);

    expect(screen.getByText('运行命令')).toBeTruthy();
    expect(screen.queryByText(/Error: Command failed with exit code 1/)).toBeNull();

    const trigger = container.querySelector('[data-slot="tool-group-trigger"]');
    if (trigger) fireEvent.click(trigger);

    expect(container.querySelector('.lucide-circle-x')).toBeTruthy();
    expect(container.querySelector('.lucide-loader')).toBeNull();
  });

  it('hides footer (copy button + timestamp) on intermediate or incomplete assistant messages', () => {
    render(<Harness sessionId="session-timestamp" />);

    expect(screen.getByText('timestamp only assistant')).toBeTruthy();
    // No result event means no isFinalAssistantMessage, so footer (timestamp) should not render.
    expect(screen.queryByText('21:40')).toBeNull();
  });

  it('keeps final message footer hidden until the full message row is hovered', () => {
    render(<Harness sessionId="session-completed-turn" />);

    const footer = screen.getByText('耗时 73.0s').closest('[data-message-footer]');
    const row = screen.getByText('Fixed and verified.').closest('[data-message-row]');

    expect(row?.className).toContain('group/message-row');
    expect(footer?.className).toContain('opacity-0');
    expect(footer?.className).toContain('group-hover/message-row:opacity-100');
  });

  it('renders the reasoning trigger like the native assistant-ui component', () => {
    const { container } = render(<Harness sessionId="session-reasoning" />);
    const trigger = container.querySelector('[data-slot="reasoning-trigger"]');
    const childSlots = Array.from(trigger?.children ?? []).map((element) =>
      element.getAttribute('data-slot'),
    );

    expect(childSlots).toEqual([
      'reasoning-trigger-icon',
      'reasoning-trigger-label',
      'reasoning-trigger-chevron',
    ]);
  });

  it('renders consecutive related tool calls inside one tool group', () => {
    const { container } = render(<Harness sessionId="session-grouped-tools" />);
    const toolGroup = container.querySelector('[data-slot="tool-group-root"]');

    expect(toolGroup).toBeTruthy();
    expect(toolGroup?.getAttribute('data-variant')).toBe('ghost');
    expect(container.querySelector('[data-slot="tool-group-trigger"]')).toBeTruthy();
  });

  it('keeps expanded tool details open across large-history running updates', async () => {
    const largeEvents = buildLargeToolHistoryEvents(200);
    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        'session-perf-large': largeEvents,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        'session-perf-large': largeEvents.map((_, index) => index + 1),
      },
      isRunning: {
        ...state.isRunning,
        'session-perf-large': false,
      },
    }));

    const { container } = render(<Harness sessionId="session-perf-large" />);

    const firstTrigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    expect(firstTrigger).toBeTruthy();
    fireEvent.click(firstTrigger!);
    expect(firstTrigger?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      useAgentStore.setState((state) => ({
        isRunning: {
          ...state.isRunning,
          'session-perf-large': true,
        },
        streamingThinking: {
          ...state.streamingThinking,
          'session-perf-large': '正在分析大量历史消息\n'.repeat(200),
        },
      }));
    });

    const triggerAfterRunning = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const expandedAfterRunning = triggerAfterRunning?.getAttribute('aria-expanded');

    expect(expandedAfterRunning).toBe('true');

    await act(async () => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          'session-perf-large': [
            ...(state.events['session-perf-large'] ?? []),
            {
              kind: 'raw',
              data: {
                type: 'tool_progress',
                tool_use_id: 'perf-tool-0',
                elapsed_time_seconds: 2,
              },
            } as AgentMessage,
          ],
        },
      }));
    });

    const expandedAfterEvent = container.querySelector('[data-slot="tool-fallback-trigger"]')?.getAttribute('aria-expanded');

    expect(expandedAfterEvent).toBe('true');
  }, 30_000);

  it('does not resolve Claude-only slash commands in Codex sessions', () => {
    expect(resolveSlashCommand('/security-review', 'codex')).toBeNull();
    expect(resolveSlashCommand('/permissions', 'codex')).toBeNull();
    expect(resolveSlashCommand('/init', 'codex')).toMatchObject({
      command: expect.objectContaining({ name: 'init' }),
    });
    expect(resolveSlashCommand('/security-review', 'claude_code')?.command.name).toBe('security-review');
  });

  it('builds image payloads from assistant-ui attachments', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'look at this' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'screenshot.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,abc123' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload).toEqual({
      text: 'look at this',
      images: [
        {
          name: 'screenshot.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    });
  });

  it('builds image payloads from multiple assistant-ui attachments', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'compare these' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'first.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,first' }],
        },
        {
          id: 'image-2',
          type: 'image',
          name: 'second.jpg',
          contentType: 'image/jpeg',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/jpeg;base64,second' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload).toEqual({
      text: 'compare these',
      images: [
        {
          name: 'first.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,first',
        },
        {
          name: 'second.jpg',
          mediaType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,second',
        },
      ],
    });
  });

  it('assigns unique attachment ids for same-name image files', async () => {
    const adapter = new CodeMuxImageAttachmentAdapter();
    const first = await adapter.add({ file: new File(['first'], 'pasted.png', { type: 'image/png' }) });
    const second = await adapter.add({ file: new File(['second'], 'pasted.png', { type: 'image/png' }) });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe('pasted.png');
    expect(second.name).toBe('pasted.png');
  });

  it('renders historical user image attachments without requiring text', () => {
    const { container } = render(<Harness sessionId="session-image-only" />);

    const image = container.querySelector('img[alt="screen.png"]') as HTMLImageElement | null;
    expect(image).toBeTruthy();
    expect(image?.src).toBe('data:image/png;base64,abc123');
  });

  it('renders user image thumbnails above the text bubble and opens a preview', () => {
    const { container } = render(<Harness sessionId="session-image-text" />);

    const bubble = container.querySelector('[data-user-message-bubble="true"]');
    const thumbnail = container.querySelector('img[alt="screen.png"]') as HTMLImageElement | null;

    expect(thumbnail).toBeTruthy();
    expect(bubble?.contains(thumbnail)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '预览图片 screen.png' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByAltText('screen.png')).toHaveLength(2);
  });

  it('does not treat slash text as a command when an image is attached', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: '/init inspect this screenshot' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'init.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,abc123' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload.images).toHaveLength(1);
    // resolveSlashCommand parses text regardless of attachments; image-gating lives in handleMessage
    expect(resolveSlashCommand(payload.text, 'codex')).toMatchObject({
      command: expect.objectContaining({ name: 'init' }),
      args: 'inspect this screenshot',
    });
  });

  it('renders directive text in user messages as chips', () => {
    const { container } = render(<Harness sessionId="session-directives" />);

    expect(screen.getByText('review').closest('[data-directive-type="command"]')).toBeTruthy();
    expect(screen.getByText('App.tsx').closest('[data-directive-type="file"]')).toBeTruthy();
    expect(screen.getByText('please check this')).toBeTruthy();
    // Now file chips have a leading icon
    expect(container.querySelector('[data-directive-value="@src/App.tsx"] svg')).toBeTruthy();
  });

  it('shows rewind only on the latest user message and rewinds only after inline edit send', async () => {
    const rewindLastTurn = vi.fn().mockResolvedValue({ text: '琛ュ厖娴嬭瘯瑕嗙洊' });
    const onSend = vi.fn(async () => {});
    useAgentStore.setState({ rewindLastTurn } as any);

    render(<Harness sessionId="session-nav" onSend={onSend} />);

    const rewindButtons = screen.getAllByRole('button', { name: '回退并编辑这条消息' });
    expect(rewindButtons).toHaveLength(1);

    fireEvent.click(rewindButtons[0]);

    expect(rewindLastTurn).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '取消' })).toBeTruthy();
    const sendButton = screen.getByRole<HTMLButtonElement>('button', { name: '发送' });
    await waitFor(() => expect(sendButton.disabled).toBe(false));

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(rewindLastTurn).toHaveBeenCalledWith('session-nav');
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: expect.any(String) }));
    });
  });

  it('rewind inline edit ignores image attachments and resends text only', async () => {
    const rewindLastTurn = vi.fn().mockResolvedValue({ text: 'describe this image' });
    const onSend = vi.fn(async () => {});
    useAgentStore.setState((state) => ({
      rewindLastTurn,
      events: {
        ...state.events,
        'session-image-rewind': [
          {
            kind: 'user',
            data: {
              content: 'describe this image',
              attachments: [{
                type: 'image',
                name: 'screen.png',
                mediaType: 'image/png',
                dataUrl: 'data:image/png;base64,abc123',
              }],
            },
          },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-image-rewind-final',
              session_id: 'session-image-rewind',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'image described' }],
              },
              parent_tool_use_id: null,
            },
          },
        ],
      },
    } as any));

    render(<Harness sessionId="session-image-rewind" onSend={onSend} />);

    fireEvent.click(screen.getByRole('button', { name: '回退并编辑这条消息' }));

    expect(await screen.findByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.queryByTestId('edit-composer-attachment-list')).toBeNull();

    const sendButton = screen.getByRole<HTMLButtonElement>('button', { name: '发送' });
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(rewindLastTurn).toHaveBeenCalledWith('session-image-rewind');
      expect(onSend).toHaveBeenCalledWith({ text: 'describe this image' });
    });
  });

  it('does not read stale message indexes when rewind removes the tail of a long thread', async () => {
    const longSessionId = 'session-long-rewind';
    const longEvents = buildLargeToolHistoryEvents(120);
    const latestUserIndex = longEvents.findLastIndex((event) => event.kind === 'user');
    const onSend = vi.fn(async () => {});
    const rewindLastTurn = vi.fn(async () => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          [longSessionId]: longEvents.slice(0, latestUserIndex),
        },
        eventTimestamps: {
          ...state.eventTimestamps,
          [longSessionId]: longEvents.slice(0, latestUserIndex).map((_, index) => index + 1),
        },
      }));
      return { text: `性能测试消息 ${latestUserIndex}` };
    });

    useAgentStore.setState((state) => ({
      rewindLastTurn,
      events: {
        ...state.events,
        [longSessionId]: longEvents,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        [longSessionId]: longEvents.map((_, index) => index + 1),
      },
    } as any));

    render(<Harness sessionId={longSessionId} onSend={onSend} />);

    fireEvent.click(screen.getByRole('button', { name: '回退并编辑这条消息' }));
    const sendButton = await screen.findByRole<HTMLButtonElement>('button', { name: '发送' });
    await waitFor(() => expect(sendButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(sendButton);
    });

    await waitFor(() => {
      expect(rewindLastTurn).toHaveBeenCalledWith(longSessionId);
      expect(onSend).toHaveBeenCalled();
    });
    expect(screen.queryByText('结果 119')).toBeNull();
  }, 30_000);

  it('does not render streaming thinking content and only shows elapsed thinking status', () => {
    const shortThinking = 'short thinking stays fully visible';
    const longThinking = `${'x'.repeat(21_000)}`;

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-short': true, 'session-stream-long': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-short': Date.now(), 'session-stream-long': Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        'session-stream-short': shortThinking,
        'session-stream-long': longThinking,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-short" />);

    // Thinking content is NOT rendered during streaming
    expect(container.textContent).not.toContain(shortThinking);
    // No collapsible reasoning block is rendered while thinking is in progress
    expect(container.querySelector('[data-slot="reasoning-trigger"]')).toBeNull();
    // Status line shows thinking label and elapsed time only
    expect(container.textContent).toContain('思考中');
    expect(container.textContent).not.toContain('tokens');

    cleanup();
    const longView = render(<Harness sessionId="session-stream-long" />);
    // Long thinking content is also NOT rendered (no streaming render at all)
    expect(longView.container.querySelector('[data-slot="reasoning-trigger"]')).toBeNull();
    expect(longView.container.textContent).toContain('思考中');
    expect(longView.container.textContent).not.toContain('tokens');
  });

  it('renders live streaming text with markdown parsing using Streamdown', () => {
    const streamingText = '**streaming bold**\n\n```ts\nconst value = 1;\n```';

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-text': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-text': Date.now() },
      streamingText: {
        ...state.streamingText,
        'session-stream-text': streamingText,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-text" />);

    // Now uses Streamdown for real-time markdown rendering
    expect(container.querySelector('[data-streaming-text="markdown"]')).toBeTruthy();
    expect(container.querySelector('.aui-md')).toBeTruthy();
  });

  it('collapses very long user messages behind a show-more control', () => {
    const { container } = render(<Harness sessionId="session-long-user" />);

    expect(screen.getByText(/line 80/)).toBeTruthy();
    const userMessageRoot = container.querySelector('[data-message-id="user-0"]');
    const bubbleColumn = userMessageRoot?.querySelector('[data-user-message-column="true"]');
    const bubble = userMessageRoot?.querySelector('[data-user-message-bubble="true"]');

    expect(bubbleColumn?.className).toContain('max-w-10/12');
    expect(bubbleColumn?.className).not.toContain('max-w-[78%]');
    expect(bubble?.className).toContain('max-h-80');
    expect(bubble?.className).toContain('overflow-hidden');
    expect(bubble?.className).not.toContain('overflow-y-auto');

    const showMore = screen.getByRole('button', { name: '查看更多' });
    fireEvent.click(showMore);

    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy();
    expect(bubble?.className).not.toContain('max-h-80');
  });

  it('collapses completed assistant process messages when compact output is enabled', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-completed-turn" />);

    expect(screen.getByText('Fixed and verified.')).toBeTruthy();
    expect(screen.queryByText('I am checking files first.')).toBeNull();

    const toggle = screen.getByRole('button', { name: /灞曞紑AI杩囩▼|展开AI过程/ });
    expect(toggle.textContent).toContain('已处理');
    expect(toggle.textContent).toContain('1m13s');

    fireEvent.click(toggle);

    expect(screen.getByText('I am checking files first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /鏀惰捣AI杩囩▼|收起AI过程/ })).toBeTruthy();
  });

  it('renders proposed_plan in final assistant messages as a plan preview card', () => {
    render(<Harness sessionId="session-plan-final" />);

    expect(screen.getByText('计划如下：')).toBeTruthy();
    expect(screen.getByText('贪吃蛇浏览器小游戏')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText(/做一个可以直接运行的浏览器小游戏/)).toBeTruthy();
    expect(screen.getByTestId('proposed-plan-preview').className).toContain('max-h-24');
    expect(document.body.textContent).not.toContain('<proposed_plan>');

    fireEvent.click(screen.getByRole('button', { name: '展开计划 贪吃蛇浏览器小游戏' }));

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [
        expect.objectContaining({
          kind: 'plan',
          planFilePath: '计划.md',
          planContent: expect.stringContaining('# 贪吃蛇浏览器小游戏'),
        }),
      ],
    });
  });

  it('copies proposed_plan markdown from the plan preview card', async () => {
    render(<Harness sessionId="session-plan-final" />);

    fireEvent.click(screen.getByRole('button', { name: '复制计划 贪吃蛇浏览器小游戏' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('# 贪吃蛇浏览器小游戏'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('## Key Changes'));
    });
  });

  it('keeps proposed_plan approval on the normal thread footer layout', () => {
    const { container } = render(<Harness sessionId="session-plan-final" />);

    const footer = container.querySelector('[data-testid="thread-viewport-footer"]');

    expect(footer?.className).toContain('mt-auto');
    expect(container.querySelector('[data-testid="thread-messages-stack"]')).toBeNull();
  });

  it('does not parse proposed_plan in non-final assistant messages', () => {
    render(<Harness sessionId="session-plan-non-final" />);

    expect(document.body.textContent).toContain('<proposed_plan>');
    expect(screen.queryByRole('button', { name: /展开计划/ })).toBeNull();
  });

  it('renders Codex-style message navigation with user title and latest assistant summary', () => {
    render(<Harness sessionId="session-nav" />);

    const nav = screen.getByTestId('message-nav');
    expect(nav.className).toContain('left-');

    const firstNavButton = screen.getByRole('button', { name: /跳转到消息 修复子智能体展示/ });
    fireEvent.mouseEnter(firstNavButton);

    expect(within(nav).getByText('修复子智能体展示')).toBeTruthy();
    expect(within(nav).getByText(/已按计划完成这次修复，核心路径都接上了/)).toBeTruthy();
    expect(within(nav).queryByText('我先检查现有实现。')).toBeNull();
  });

  it('hides the message navigation when the thread viewport becomes narrow', async () => {
    const { container } = render(<Harness sessionId="session-nav" />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement | null;

    expect(viewport).toBeTruthy();
    expect(screen.getByTestId('message-nav')).toBeTruthy();

    triggerResize(viewport!, 720);

    await waitFor(() => {
      expect(screen.queryByTestId('message-nav')).toBeNull();
    });
  });

  it('keeps the message navigation floating without shifting thread content off center', () => {
    render(<Harness sessionId="session-nav" />);

    const shell = screen.getByTestId('thread-content-shell');
    expect(shell.className).toContain('px-4');
    expect(shell.className).not.toContain('pl-14');
    expect(shell.className).not.toContain('pr-4');
    expect((shell as HTMLElement).style.maxWidth).toBe('var(--content-width, 52rem)');
  });

  it('shows the message navigation popover on keyboard focus and scrolls to the selected turn', () => {
    render(<Harness sessionId="session-nav" />);

    const nav = screen.getByTestId('message-nav');
    const secondNavButton = screen.getByRole('button', { name: /跳转到消息 调整权限审批功能/ });
    fireEvent.focus(secondNavButton);

    expect(within(nav).getByText('调整权限审批功能')).toBeTruthy();
    expect(within(nav).getByText(/权限审批入口已经调整完成/)).toBeTruthy();

    fireEvent.click(secondNavButton);

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });

  it('keeps message navigation compact and animates marker widths as a mountain around hover', () => {
    render(<Harness sessionId="session-nav" />);

    const navButtons = screen.getAllByRole('button', { name: /跳转到消息/ });
    expect(navButtons).toHaveLength(5);

    const markerTops = navButtons.map((button) =>
      Number.parseFloat((button.parentElement as HTMLElement).style.top),
    );
    const markerGaps = markerTops.slice(1).map((top, index) => top - markerTops[index]);
    expect(Math.max(...markerGaps)).toBeLessThanOrEqual(8);

    fireEvent.mouseEnter(navButtons[2]);

    const widths = navButtons.map((button) =>
      Number.parseFloat(((button as HTMLElement).firstElementChild as HTMLElement).style.width),
    );
    expect(widths).toEqual([14, 22, 34, 22, 14]);
  });

  it('keeps every message navigation item accessible for long histories', () => {
    const manyTurns: AgentMessage[] = Array.from({ length: 30 }, (_, index) => ({
      kind: 'user',
      data: { content: `历史消息 ${index + 1}` },
    }));
    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        'session-many-nav': manyTurns,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        'session-many-nav': manyTurns.map((_, index) => index + 1),
      },
    }));

    render(<Harness sessionId="session-many-nav" />);

    const navButtons = screen.getAllByRole('button', { name: /跳转到消息/ });
    expect(navButtons).toHaveLength(30);
    expect(screen.getByRole('button', { name: '跳转到消息 历史消息 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '跳转到消息 历史消息 30' })).toBeTruthy();
  });

  it('uses a larger hit target than the visible message navigation marker', () => {
    render(<Harness sessionId="session-nav" />);

    const firstNavButton = screen.getAllByRole('button', { name: /跳转到消息/ })[0] as HTMLElement;
    const marker = firstNavButton.firstElementChild as HTMLElement;

    expect(firstNavButton.className).toContain('h-4');
    expect(firstNavButton.className).toContain('w-12');
    expect(marker.style.height).toBe('2px');
  });

  it('returns tool durations from event-reported data only', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-repeat',
          session_id: 'session-tool-repeat',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-repeat', name: 'mcp__context7__query_docs', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-first',
          session_id: 'session-tool-repeat',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-repeat', content: 'first' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'raw',
        data: {
          type: 'tool_progress',
          tool_use_id: 'call-repeat',
          elapsed_time_seconds: 0.25,
        },
      },
    ];

    // Now uses event-reported durations only
    expect(buildToolDurationMap(events)).toEqual({
      'call-repeat': 250,
    });
  });

  it('returns empty durations when no tool_progress or task_notification events', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-no-progress',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    // No event-reported durations, so returns empty
    expect(buildToolDurationMap(events)).toEqual({});
  });
});
