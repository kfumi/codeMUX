// @vitest-environment jsdom
/**
 * 计数型守卫：**追加一个事件时，叶子组件的渲染次数不得随挂载行数增长**。
 *
 * 背景（本仓库两次实测的结论）：
 * - 用 `<Profiler>` 量过：全量挂载 8 轮时"追加一个事件"的提交耗时 38.7ms，40 轮时 136.2ms
 *   ——随挂载行数近乎线性。
 * - 换成计数（本文件的手法）后更清楚：不加 memo 时，一次追加会让三个叶子重渲染 **33 次**
 *   （挂载 8 轮 / 24 行）与 **161 次**（挂载 40 轮 / 120 行），约每行 1.35 次。
 *   也就是每来一个事件，所有已挂载的历史行都跟着重渲染一遍。
 *
 * 根因：`CodeMuxThreadRenderContext` 的值依赖 `activityRuns` / `toolDurations` /
 * `subagentRunActivity` 这三张每次事件追加都**换身份**的查找表，于是每一行的子树都会被重新
 * 协调（React 的 `memo` 挡不住 context 变化，`MarkdownText` 自己虽然是 memo，但它在被
 * 重新挂载的那一层里也要走一遍）。修法见 `CodeMuxMessageParts.tsx` 末尾三个 `memo` 导出。
 *
 * **为什么用计数而不是毫秒**：本仓库的纪律是"毫秒不进 CI 门禁"。计数是确定的，且这条
 * 不变量（"不随挂载行数增长"）正是问题本身，与机器快慢无关。
 */
import { cleanup, render } from '@testing-library/react';
import { act, memo, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({
  rows: 0,
  text: 0,
  tool: 0,
  data: 0,
  committedMarkdown: 0,
  liveMarkdown: 0,
}));

/**
 * 包一层**同样带 memo 的**计数器。
 *
 * 计数器必须自己和被测组件一样是 `memo` 的：否则父组件每次重渲染都会让普通函数组件
 * 重新执行，计数会变成"父组件渲染次数"，而不是"这个叶子真的渲染了几次"。
 * 计数写在 render 体内，所以只在 memo 判定需要渲染时执行。
 */
vi.mock('./CodeMuxMessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CodeMuxMessageParts')>();

  return {
    ...actual,
    CodeMuxTextMessagePart: memo(function CodeMuxTextMessagePartCounter(
      props: Parameters<typeof actual.CodeMuxTextMessagePart>[0],
    ) {
      counts.text += 1;
      return <actual.CodeMuxTextMessagePart {...props} />;
    }),
    CodeMuxToolCallMessagePart: memo(function CodeMuxToolCallMessagePartCounter(
      props: Parameters<typeof actual.CodeMuxToolCallMessagePart>[0],
    ) {
      counts.tool += 1;
      return <actual.CodeMuxToolCallMessagePart {...props} />;
    }),
    CodeMuxDataMessagePart: memo(function CodeMuxDataMessagePartCounter(
      props: Parameters<typeof actual.CodeMuxDataMessagePart>[0],
    ) {
      counts.data += 1;
      return <actual.CodeMuxDataMessagePart {...props} />;
    }),
  };
});

/**
 * 行级计数器：`MessagePrimitive.Root` 每个消息行渲染一次，所以它的渲染次数就是"行渲染次数"。
 *
 * 用 `importOriginal` 做**局部**替换（只换 `Root`），其余导出保持真实实现，运行时 Provider 与
 * 分组部件都不受影响。
 */
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    MessagePrimitive: {
      ...actual.MessagePrimitive,
      Root: (props: ComponentProps<typeof actual.MessagePrimitive.Root>) => {
        counts.rows += 1;
        return <actual.MessagePrimitive.Root {...props} />;
      },
    },
  };
});

import { buildConversationTurns } from '../../../lib/conversationTurns';
import { buildLongSessionEvents } from '../../../lib/dev/longSessionFixture';
import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types/session';
import { TooltipProvider } from '../../ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import {
  CodeMuxThread,
  assistantRowBindingsEqual,
  type AssistantRowBindings,
} from './CodeMuxThread';
import type { SubagentActivity } from '../../../lib/subagentActivity';

function toPlainMarkdownBlocks(children: ReactNode): ReactNode {
  if (typeof children !== 'string') return children ?? null;

  return children
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .map((line, index) => <div key={index}>{line.replace(/^#{1,6}\s+/, '')}</div>);
}

// 真实 remark/rehype + Shiki 在 jsdom 里的代价会吃掉整个测试超时；本文件只数渲染次数。
vi.mock('streamdown', () => ({
  defaultRehypePlugins: {},
  Streamdown: ({ children, className }: { children?: ReactNode; className?: string }) => {
    // 这个 mock 只被**实时缓冲**那条路径用到（committed 行走下面的原语），所以它的次数就是
    // "实时 markdown 重画了几次"。
    counts.liveMarkdown += 1;
    return <div className={className}>{toPlainMarkdownBlocks(children)}</div>;
  },
  /** 生产代码用它做增量分块；mock 只返回单块，增量缓存自然退化为整体解析。 */
  parseMarkdownIntoBlocks: (markdown: string) => [markdown],
}));

vi.mock('@assistant-ui/react-streamdown', async () => {
  const { useMessagePartText } = await import('@assistant-ui/react');

  return {
    /**
     * committed（已提交）消息的 markdown 走这条原语。数它的渲染次数，就等于数
     * "已提交行有没有在流式期间被重新解析"——AC3 要回答的正是这个问题。
     */
    StreamdownTextPrimitive: ({ className }: { className?: string }) => {
      const part = useMessagePartText();
      counts.committedMarkdown += 1;
      return <div className={className}>{toPlainMarkdownBlocks(part.text)}</div>;
    },
  };
});

vi.mock('@streamdown/code', () => ({
  code: { name: 'stub-code-highlighter', type: 'code-highlighter' },
}));

const SESSION_ID = 'session-row-render-counts';
let globalsInstalled = false;

async function flushFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  }
}

function resetCounts(): void {
  counts.text = 0;
  counts.tool = 0;
  counts.data = 0;
  counts.rows = 0;
  counts.committedMarkdown = 0;
  counts.liveMarkdown = 0;
}

function seed(turnCount: number): void {
  const session: Session = {
    id: SESSION_ID,
    title: 'row render counts',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    permission_config: null,
    plan_mode: null,
    project_id: null,
    origin: 'native',
    is_read_only: false,
    created_at: '',
    updated_at: '',
    is_archived: false,
    is_pinned: false,
  };
  useSessionStore.setState({
    sessions: [session],
    archivedSessions: [],
    activeSessionId: SESSION_ID,
    isLoading: false,
    error: null,
  });

  const events = buildLongSessionEvents(turnCount, SESSION_ID);
  useAgentStore.setState((state) => ({
    events: { ...state.events, [SESSION_ID]: events },
    turns: { ...state.turns, [SESSION_ID]: buildConversationTurns(events, { isRunning: false }) },
    // 全量挂载：让挂载行数确实随轮数增长，否则这条守卫会因"没挂载东西"而假通过。
    threadWindowSizes: { ...state.threadWindowSizes, [SESSION_ID]: turnCount },
    eventTimestamps: { ...state.eventTimestamps, [SESSION_ID]: events.map((_, index) => index + 1) },
    isRunning: { ...state.isRunning, [SESSION_ID]: false },
    forceStopped: { ...state.forceStopped, [SESSION_ID]: false },
    streamingText: { ...state.streamingText, [SESSION_ID]: '' },
    streamingThinking: { ...state.streamingThinking, [SESSION_ID]: '' },
  }));
}

/** 与 fixture 同形的一条新事件，用来模拟"流式期间又来了一条"。 */
function appendedEvent(): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'row-render-counts-appended',
      session_id: SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: '### 新增\n\n- 一行新内容' }] },
      parent_tool_use_id: null,
    },
  } as unknown as AgentMessage;
}

/** 全量挂载 `turnCount` 轮，然后追加**一个**事件，返回这次追加引起的叶子渲染次数。 */
async function measureAppend(turnCount: number) {
  seed(turnCount);
  render(
    <TooltipProvider>
      <CodeMuxAssistantRuntimeProvider
        sessionId={SESSION_ID}
        onSend={vi.fn(async () => {})}
        onCommand={vi.fn(async () => {})}
      >
        <CodeMuxThread sessionId={SESSION_ID} />
      </CodeMuxAssistantRuntimeProvider>
    </TooltipProvider>,
  );
  await flushFrames(3);
  // 挂载期与钉底帧都会渲染；只看"追加一个事件"这一下。
  resetCounts();
  await flushFrames(1);
  resetCounts();

  const mountedRows = document.querySelectorAll('[data-message-row]').length;

  await act(async () => {
    useAgentStore.setState((state) => {
      const next = [...(state.events[SESSION_ID] ?? []), appendedEvent()];
      return {
        events: { ...state.events, [SESSION_ID]: next },
        turns: { ...state.turns, [SESSION_ID]: buildConversationTurns(next, { isRunning: false }) },
      };
    });
  });
  await flushFrames(1);

  return { turnCount, mountedRows, leafRenders: counts.text + counts.tool + counts.data, rowRenders: counts.rows };
}

describe('追加一个事件时的叶子渲染计数', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalsInstalled) {
      globalsInstalled = true;
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver);
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    }
    resetCounts();
  });

  afterEach(() => {
    cleanup();
  });

  it('长会话里追加一个事件，历史行的叶子组件不再跟着重渲染', async () => {
    const small = await measureAppend(8);
    cleanup();
    const large = await measureAppend(40);

    // 需要读数时：`$env:CODEMUX_ROW_COUNT_TRACE=1; npx vitest run <本文件>`。默认静默，免得刷日志。
    if (process.env.CODEMUX_ROW_COUNT_TRACE) {
      // eslint-disable-next-line no-console
      console.log('ROW_RENDER_COUNTS', JSON.stringify({ small, large }));
    }

    // 前置条件：两次挂载的行数必须真的差一个量级，否则下面的相等断言毫无意义。
    expect(small.mountedRows).toBeGreaterThan(20);
    expect(large.mountedRows).toBeGreaterThan(100);

    // 不变量：这次追加引起的叶子渲染次数**只取决于这次追加自己带来的新行**，
    // 与已挂载的行数无关。回归前是 33 次（8 轮）对 161 次（40 轮）。
    expect(large.leafRenders).toBe(small.leafRenders);
    // 再加一条绝对上界，防止"两边一起变差"也能通过相等断言。
    expect(large.leafRenders).toBeLessThanOrEqual(8);
  }, 180_000);

  it('长会话里追加一个事件，历史行不会整体重渲染', async () => {
    const small = await measureAppend(8);
    cleanup();
    const large = await measureAppend(40);

    if (process.env.CODEMUX_ROW_COUNT_TRACE) {
      // eslint-disable-next-line no-console
      console.log('ROW_RENDER_COUNTS_ROWS', JSON.stringify({ small, large }));
    }

    // 前置条件同上：两次挂载的行数必须真的差一个量级。
    expect(small.mountedRows).toBeGreaterThan(20);
    expect(large.mountedRows).toBeGreaterThan(100);

    // 不变量：追加一个事件引起的**行**渲染次数，只取决于这一下自己带来的新行
    // （外加"最后一行"因为不再是最末行而更新一次间距），与已挂载行数无关。
    expect(large.rowRenders).toBe(small.rowRenders);
    // 绝对上界防止"两边一起变差"也能通过相等断言。
    expect(large.rowRenders).toBeLessThanOrEqual(8);
  }, 180_000);
});

/**
 * 比较器的**完备性**用例。
 *
 * 收窄的代价是：任何一个字段漏比，都会变成"UI 静默不更新"——比多渲染几次严重得多。所以这里
 * 机械地逐字段翻转：`assistantRowBindingsEqual` 必须对每一个字段敏感。
 * 唯一有意的例外是 `usedDurations`：它按内容指纹（`usedDurationsKey`）参与比较，见本文件最后一组断言。
 */
function sampleBindings(): AssistantRowBindings {
  const activity = { nodes: [{ id: 'sub-1' }], summary: { running: 1 } } as unknown as SubagentActivity;

  return {
    render: 'content',
    compactToggle: true,
    collapse: { turnKey: 'turn-1', durationMs: 1200, stepCount: 3, hasError: false },
    collapseExpanded: true,
    hideCollapsedContent: false,
    hideCollapsedReasoning: true,
    runKey: 'run-1',
    runLive: true,
    runHead: true,
    runOpen: false,
    hasDelegation: true,
    delegationRunning: true,
    delegationNodeCount: 2,
    delegationCardVisible: true,
    delegationCardActivity: activity,
    partsVisible: true,
    footerVisible: true,
    shouldRenderFooter: true,
    footerDurationMs: 900,
    sourceRole: 'assistant',
    sourceUuid: 'uuid-1',
    sourceProviderTurnId: 'provider-turn-1',
    sourceProviderTurnOrdinal: 2,
    isFinal: true,
    sourceTimestamp: 111,
    isForkable: true,
    isLastRow: false,
    bottomSpacing: 'mb-2',
    dataMessageText: '正文',
    parsePlan: true,
    usedDurationsKey: 'tool-1:12',
    usedDurations: { 'tool-1': 12 },
    parts: [
      { key: { kind: 'text', text: '第一段' }, activityRunPart: false },
      {
        key: {
          kind: 'tool-call',
          toolName: 'Read',
          toolCallId: 'tool-1',
          args: { file: 'a.ts' },
          argsText: '{"file":"a.ts"}',
          result: 'ok',
          isError: false,
          status: { type: 'complete' },
        },
        activityRunPart: true,
      },
    ],
  };
}

/** 造一个"肯定不同"的值，用于逐字段翻转。 */
function flipValue(value: unknown): unknown {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}!`;
  return { flipped: true };
}

describe('AssistantRowBindings 比较器的完备性', () => {
  it('每个标量字段被改动都必须判为不同', () => {
    const base = sampleBindings();
    const excluded = new Set(['collapse', 'parts', 'delegationCardActivity', 'usedDurations']);
    const scalarKeys = (Object.keys(base) as Array<keyof AssistantRowBindings>)
      .filter((key) => !excluded.has(key));

    // 前置：字段真被枚举到了，否则这条用例会因为"没字段可比"而假通过。
    expect(scalarKeys.length).toBeGreaterThan(20);

    for (const key of scalarKeys) {
      const mutated = { ...base, [key]: flipValue(base[key]) } as AssistantRowBindings;
      expect(
        assistantRowBindingsEqual(base, mutated),
        `字段 ${String(key)} 没有被比较到`,
      ).toBe(false);
    }
  });

  it('折叠开关的每个子字段被改动都必须判为不同', () => {
    const base = sampleBindings();
    const collapse = base.collapse!;

    for (const key of Object.keys(collapse) as Array<keyof typeof collapse>) {
      const mutated = {
        ...base,
        collapse: { ...collapse, [key]: flipValue(collapse[key]) },
      } as AssistantRowBindings;
      expect(
        assistantRowBindingsEqual(base, mutated),
        `折叠字段 ${String(key)} 没有被比较到`,
      ).toBe(false);
    }

    expect(assistantRowBindingsEqual(base, { ...base, collapse: undefined })).toBe(false);
  });

  it('每个 part 的每个字段被改动都必须判为不同', () => {
    const base = sampleBindings();

    for (let partIndex = 0; partIndex < base.parts.length; partIndex += 1) {
      const part = base.parts[partIndex];
      const keyFields = Object.keys(part.key) as Array<keyof typeof part.key>;

      for (const field of keyFields) {
        const nextKey = { ...part.key, [field]: flipValue(part.key[field]) } as typeof part.key;
        const mutated = {
          ...base,
          parts: base.parts.map((entry, index) => (index === partIndex
            ? { ...part, key: nextKey }
            : entry)),
        } as AssistantRowBindings;
        expect(
          assistantRowBindingsEqual(base, mutated),
          `part #${partIndex} 的字段 ${String(field)} 没有被比较到`,
        ).toBe(false);
      }

      const toggledVisible = {
        ...base,
        parts: base.parts.map((entry, index) => (index === partIndex
          ? { ...part, activityRunPart: !part.activityRunPart }
          : entry)),
      } as AssistantRowBindings;
      expect(assistantRowBindingsEqual(base, toggledVisible)).toBe(false);
    }

    // part 数量变化也要被发现。
    expect(assistantRowBindingsEqual(base, { ...base, parts: base.parts.slice(0, 1) })).toBe(false);
  });

  it('卡片活动对象按身份比较：换一个实例就必须重画', () => {
    const base = sampleBindings();
    const otherActivity = { nodes: [{ id: 'sub-1' }], summary: { running: 1 } } as unknown as SubagentActivity;

    expect(assistantRowBindingsEqual(base, { ...base, delegationCardActivity: otherActivity })).toBe(false);
    expect(assistantRowBindingsEqual(base, { ...base, delegationCardActivity: undefined })).toBe(false);
  });

  it('工具耗时按内容指纹比较（有意的例外，但内容变化必须被发现）', () => {
    const base = sampleBindings();

    // 同样的内容换个对象：不算不同（所以行体不用为此重画）。
    expect(assistantRowBindingsEqual(base, { ...base, usedDurations: { 'tool-1': 12 } })).toBe(true);
    // 内容变了：必须不同（`usedDurationsKey` 就是它的指纹）。
    expect(assistantRowBindingsEqual(base, { ...base, usedDurationsKey: 'tool-1:13' })).toBe(false);
    // 多了一个工具耗时也必须被发现。
    expect(assistantRowBindingsEqual(base, { ...base, usedDurationsKey: 'tool-1:12|tool-2:5' })).toBe(false);
  });
});

/**
 * AC3：**流式期间增长的是实时缓冲，不是已提交消息**。
 *
 * 事实来源（`agentStore.ts`）：`content_block_delta` 里的 `text_delta` 走 `queueStreamingDelta`
 * → `streamingText`（实时缓冲），**从不**写进 `events`；`events` 只在一条完整的 assistant 事件到达时
 * 写入，并在同一处清空实时缓冲。所以"已提交行的文本在流式期间增长"这个前提在这个数据流里不成立，
 * 也就不需要在 committed 路径上再注入一次增量分块。
 *
 * 这条用例把结论钉成计数：把实时缓冲连续推进 20 次，
 * - committed 行的 markdown（`StreamdownTextPrimitive`）渲染次数**必须为 0**；
 * - 实时缓冲的 markdown 渲染次数**必须大于 0**（否则说明这条用例什么都没测到）。
 */
describe('流式期间的 markdown 重画落在哪条路径', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalsInstalled) {
      globalsInstalled = true;
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver);
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    }
    resetCounts();
  });

  afterEach(() => {
    cleanup();
  });

  it('实时缓冲推进 20 次，committed 行的 markdown 一次都不重画', async () => {
    seed(8);
    render(
      <TooltipProvider>
        <CodeMuxAssistantRuntimeProvider
          sessionId={SESSION_ID}
          onSend={vi.fn(async () => {})}
          onCommand={vi.fn(async () => {})}
        >
          <CodeMuxThread sessionId={SESSION_ID} />
        </CodeMuxAssistantRuntimeProvider>
      </TooltipProvider>,
    );
    await flushFrames(3);
    resetCounts();
    await flushFrames(1);
    resetCounts();

    for (let step = 1; step <= 20; step += 1) {
      await act(async () => {
        useAgentStore.setState((state) => ({
          streamingText: { ...state.streamingText, [SESSION_ID]: `流式正文第 ${step} 段。\n\n`.repeat(step) },
        }));
      });
      await flushFrames(1);
    }

    if (process.env.CODEMUX_ROW_COUNT_TRACE) {
      // eslint-disable-next-line no-console
      console.log('STREAMING_MARKDOWN_COUNTS', JSON.stringify({
        committedMarkdown: counts.committedMarkdown,
        liveMarkdown: counts.liveMarkdown,
        rowRenders: counts.rows,
      }));
    }

    expect(counts.liveMarkdown).toBeGreaterThan(0);
    expect(counts.committedMarkdown).toBe(0);
  }, 120_000);
});
