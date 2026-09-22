// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConversationTurns } from '../../../lib/conversationTurns';
import {
  LONG_SESSION_EVENTS_PER_TURN,
  buildLongSessionEvents,
  userMessageEventIndex,
} from '../../../lib/dev/longSessionFixture';
import {
  THREAD_WINDOW_EVENT_THRESHOLD,
  THREAD_WINDOW_STEADY_TURNS,
} from '../../../lib/threadWindow';
import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types/session';
import { TooltipProvider } from '../../ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxThread } from './CodeMuxThread';

const WINDOW_SESSION_ID = 'session-window-test';
const WINDOW_TURN_COUNT = 60;

/**
 * 真实 markdown 渲染层在 jsdom 里代价过高（照抄 CodeMuxAssistantRuntime.test.tsx 的
 * 降级手法）：className 与文本照常渲染，只剥离标题/列表/引用前缀和代码围栏。
 */
function toPlainMarkdownBlocks(children: ReactNode): ReactNode {
  if (typeof children !== 'string') {
    return children ?? null;
  }

  return children
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .map((line, index) => (
      <div key={index}>
        {line.replace(/^#{1,6}\s+/, '').replace(/^([-*+]|\d+\.)\s+/, '').replace(/^>\s+/, '')}
      </div>
    ));
}

vi.mock('streamdown', () => ({
  defaultRehypePlugins: {},
  Streamdown: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{toPlainMarkdownBlocks(children)}</div>
  ),
  /** 生产代码用它做增量分块；mock 只返回单块，增量缓存自然退化为整体解析。 */
  parseMarkdownIntoBlocks: (markdown: string) => [markdown],
}));

vi.mock('@assistant-ui/react-streamdown', async () => {
  const { useMessagePartText } = await import('@assistant-ui/react');

  return {
    StreamdownTextPrimitive: ({ className }: { className?: string }) => {
      const part = useMessagePartText();
      return <div className={className}>{toPlainMarkdownBlocks(part.text)}</div>;
    },
  };
});

vi.mock('@streamdown/code', () => ({
  code: { name: 'stub-code-highlighter', type: 'code-highlighter' },
}));

const originalScrollTo = HTMLElement.prototype.scrollTo;

function Harness({ sessionId }: { sessionId: string }) {
  return (
    <TooltipProvider>
      <CodeMuxAssistantRuntimeProvider
        sessionId={sessionId}
        onSend={vi.fn(async () => {})}
        onCommand={vi.fn(async () => {})}
      >
        <CodeMuxThread sessionId={sessionId} />
      </CodeMuxAssistantRuntimeProvider>
    </TooltipProvider>
  );
}

function messageRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]'));
}

/** 已挂载的用户消息行的绝对事件下标（id="msg-N"）。 */
function mountedUserEventIndexes(): number[] {
  return messageRows()
    .map((row) => row.id)
    .filter((id) => id.startsWith('msg-'))
    .map((id) => Number.parseInt(id.slice(4), 10))
    .sort((left, right) => left - right);
}

function seedSession(turnCount: number): AgentMessage[] {
  const session: Session = {
    id: WINDOW_SESSION_ID,
    title: '窗口测试',
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
    activeSessionId: WINDOW_SESSION_ID,
    isLoading: false,
    error: null,
  });

  const events = buildLongSessionEvents(turnCount, WINDOW_SESSION_ID);
  useAgentStore.setState((state) => ({
    events: { ...state.events, [WINDOW_SESSION_ID]: events },
    // store 的模块级订阅者会从 events 派生 turns；这里显式给出，保证 totalTurns 确定。
    turns: {
      ...state.turns,
      [WINDOW_SESSION_ID]: buildConversationTurns(events, { isRunning: false }),
    },
    eventTimestamps: {
      ...state.eventTimestamps,
      [WINDOW_SESSION_ID]: events.map((_, index) => index + 1),
    },
    isRunning: { ...state.isRunning, [WINDOW_SESSION_ID]: false },
    forceStopped: { ...state.forceStopped, [WINDOW_SESSION_ID]: false },
    streamingText: { ...state.streamingText, [WINDOW_SESSION_ID]: '' },
    streamingThinking: { ...state.streamingThinking, [WINDOW_SESSION_ID]: '' },
  }));
  return events;
}

beforeEach(() => {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix 组件在 jsdom 里会调 scrollIntoView / scrollTo，给占位实现。
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: originalScrollTo,
  });
  useAgentStore.setState((state) => ({
    events: {},
    turns: {},
    eventTimestamps: {},
    threadWindowSizes: {},
    isRunning: {},
    forceStopped: {},
    streamingText: {},
    streamingThinking: {},
  }));
  useSessionStore.setState({
    sessions: [],
    archivedSessions: [],
    activeSessionId: null,
    isLoading: false,
    error: null,
  });
});

describe('尾部挂载窗口（工单 03）', () => {
  it('长会话挂载量有界，msg-N 保持绝对下标，稳态下无首帧占位', async () => {
    const fullEventCount = WINDOW_TURN_COUNT * LONG_SESSION_EVENTS_PER_TURN;
    expect(fullEventCount).toBeGreaterThan(THREAD_WINDOW_EVENT_THRESHOLD);
    seedSession(WINDOW_TURN_COUNT);

    render(<Harness sessionId={WINDOW_SESSION_ID} />);

    // 稳态扩张完成的确切信号：第一条已挂载用户行 = 第 30 轮（下标 120）。
    // 不能用「行数 < 全量」当信号 —— 首帧（8 轮）同样满足，会与扩张竞态。
    await waitFor(() => {
      expect(mountedUserEventIndexes()[0]).toBe(
        userMessageEventIndex(WINDOW_TURN_COUNT - THREAD_WINDOW_STEADY_TURNS),
      );
    }, 10_000);
    const rows = messageRows().length;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(THREAD_WINDOW_STEADY_TURNS * 3 + 2);
    expect(rows).toBeLessThan(WINDOW_TURN_COUNT * 3);
    // 绝对事件下标 —— 稳态挂载尾部 30 轮 ⇒ 第一条用户行是第 30 轮（下标 120）。
    const indexes = mountedUserEventIndexes();
    expect(indexes[0]).toBe(userMessageEventIndex(WINDOW_TURN_COUNT - THREAD_WINDOW_STEADY_TURNS));

    // 有被隐藏的历史 ⇒ 导航顶部出现「更早历史」延续标记；首帧占位在稳态已移除。
    expect(screen.queryByTestId('thread-earlier-history')).not.toBeNull();
    expect(screen.queryByTestId('thread-window-spacer')).toBeNull();
  }, 30_000);

  it('点击「更早历史」使窗口增长，先前不可达的轮次变为已挂载且下标仍绝对', async () => {
    seedSession(WINDOW_TURN_COUNT);
    render(<Harness sessionId={WINDOW_SESSION_ID} />);

    await waitFor(() => {
      expect(mountedUserEventIndexes()[0]).toBe(
        userMessageEventIndex(WINDOW_TURN_COUNT - THREAD_WINDOW_STEADY_TURNS),
      );
    }, 10_000);
    const rowsBefore = messageRows().length;

    act(() => {
      screen.getByTestId('thread-earlier-history').click();
    }, 10_000);

    // 增长一步（+20 轮）：第一条用户行向更早移动，挂载行数增加。
    await waitFor(() => {
      expect(mountedUserEventIndexes()[0]).toBeLessThan(
        userMessageEventIndex(WINDOW_TURN_COUNT - THREAD_WINDOW_STEADY_TURNS),
      );
    }, 10_000);
    await waitFor(() => {
      expect(messageRows().length).toBeGreaterThan(rowsBefore);
    }, 10_000);
  }, 30_000);

  it('短会话不进入窗口：全量挂载，无延续标记，无首帧占位', async () => {
    seedSession(8);
    render(<Harness sessionId={WINDOW_SESSION_ID} />);

    await waitFor(() => {
      expect(messageRows().length).toBeGreaterThan(0);
    }, 10_000);
    expect(messageRows().length).toBe(8 * 3);
    expect(mountedUserEventIndexes()).toEqual(
      Array.from({ length: 8 }, (_, turn) => userMessageEventIndex(turn)),
    );
    expect(screen.queryByTestId('thread-earlier-history')).toBeNull();
    expect(screen.queryByTestId('thread-window-spacer')).toBeNull();
  }, 30_000);
});
