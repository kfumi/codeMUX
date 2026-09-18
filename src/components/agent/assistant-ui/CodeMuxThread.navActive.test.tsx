// @vitest-environment jsdom
/**
 * 工单 02（成本那一半）：导航高亮从「每帧遍历全部用户消息并逐条读几何」改成
 * 「布局变化时重算一次偏移缓存、滚动期间只比较缓存」。
 *
 * 两层覆盖（源码契约在 `CodeMuxThread.navActiveSource.test.ts`，node 环境读源码文本）：
 * 1. 纯比较语义：`pickActiveEventIndex` 与原先逐条测量时的判定顺序一致。
 * 2. jsdom 集成（长会话 160 条事件）：首次打开钉底时高亮是最后一轮；滚动中高亮跟随
 *    缓存偏移且一次突发里 `getBoundingClientRect` 调用次数为 0；行高变化
 *    （ResizeObserver）与点击跳转后缓存确实被重算。
 *
 * 工单 02（落点精确性）：`scrollToMessage` 会在长会话里开一个「跳转测量作用域」属性
 * （`data-thread-measuring`），让落点算式在稳定坐标系里算、并在飞行期间保持稳定。
 * 第三组测试钉住它的生命周期：进入 → 发起滚动 → 飞行期间保持 → 落定（`scrollend` 或超时）
 * 或用户手势打断后移除；卸载也必须收尾。CSS 侧规则在 `styles/globals.css`，真实引擎里的
 * 落点精度由 `scripts/e2e/transcript-probe` 裁决。
 *
 * 口径说明：这里把 `scrollTop` 排除在「布局几何」之外 —— 它是滚动位置，不读它就
 * 无法判断滚到哪里；工单 01 的基准计数器（`longSessionBenchmark.ts`）同样不统计它。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLongSessionEvents, userMessageEventIndex } from '../../../lib/dev/longSessionFixture';
import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types/session';
import { TooltipProvider } from '../../ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxThread, pickActiveEventIndex, type NavOffsetEntry } from './CodeMuxThread';

// ── markdown 渲染层降级（照抄 CodeMuxAssistantRuntime.test.tsx） ──────────────
// 真实 remark/rehype + Shiki 在 jsdom 里的代价会吃掉整个测试超时；这里只关心导航。
function toPlainMarkdownBlocks(children: ReactNode): ReactNode {
  if (typeof children !== 'string') {
    return children ?? null;
  }

  return children
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .map((line, index) => <div key={index}>{line.replace(/^#{1,6}\s+/, '')}</div>);
}

vi.mock('streamdown', () => ({
  defaultRehypePlugins: {},
  Streamdown: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{toPlainMarkdownBlocks(children)}</div>
  ),
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

// ── 常量与夹具 ──────────────────────────────────────────────────────────────

const NAV_SESSION_ID = 'session-nav-offsets';
/** 40 轮 = 160 条事件：跨过长会话阈值（120），导航项也因此足够多。 */
const NAV_TURN_COUNT = 40;
const EVENTS_PER_TURN = 4;
/**
 * 假行高：对齐 `[data-long-thread] [data-message-row]` 的
 * `contain-intrinsic-size: auto 200px` 量级 —— 从未渲染过的行就是靠这个估算高度参与
 * 布局的，也正因如此「用测量缓存算高亮」必须和逐条测量得出同一个答案。
 */
const ROW_PITCH_PX = 200;
/** 视口的假几何：足以容纳全部行，且不会落进「两个 0 都比较相等」的退化钉底分支。 */
const VIEWPORT_SCROLL_HEIGHT = ROW_PITCH_PX * NAV_TURN_COUNT * EVENTS_PER_TURN;
const VIEWPORT_CLIENT_HEIGHT = 800;

// ── 假几何：行按 eventIndex 线性排布，随滚动位置平移 ─────────────────────────

/** 覆盖某行的内容坐标偏移；未覆盖的行按 `eventIndex × ROW_PITCH_PX` 推算。 */
const rowOffsetOverrides = new Map<number, number>();
/** 被测路径上的 `getBoundingClientRect` 调用次数（滚动期间必须为 0）。 */
let layoutReadCount = 0;

const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];
const originalScrollTo = HTMLElement.prototype.scrollTo;

function viewportElement(): HTMLElement | null {
  return document.querySelector('[data-testid="thread-viewport"]');
}

function makeRect(top: number, height = ROW_PITCH_PX): DOMRect {
  const width = 800;
  if (typeof DOMRect === 'function') {
    return new DOMRect(0, top, width, height);
  }

  const plain = { x: 0, y: top, width, height, top, right: width, bottom: top + height, left: 0 };
  return { ...plain, toJSON: () => plain } as unknown as DOMRect;
}

/** 一行的视口坐标 top：内容坐标偏移减去当前滚动位置（真实布局的等价物）。 */
function rowTop(eventIndex: number): number {
  const contentOffset = rowOffsetOverrides.get(eventIndex) ?? eventIndex * ROW_PITCH_PX;
  return contentOffset - (viewportElement()?.scrollTop ?? 0);
}

function installLayoutMock(): () => void {
  const original = Element.prototype.getBoundingClientRect;

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    layoutReadCount += 1;

    const rowMatch = /^msg-(\d+)$/.exec(this.id);
    if (rowMatch) {
      return makeRect(rowTop(Number(rowMatch[1])));
    }

    if (this.getAttribute('data-testid') === 'thread-viewport') {
      return makeRect(0);
    }

    // 其余元素沿用 jsdom 的零矩形：本文件只关心导航测量这一条路径。
    return original.call(this);
  };

  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** 一次滚动：把 scrollTop 赋值与 scroll 事件都做掉。 */
function scrollViewportTo(scrollTop: number): void {
  const viewport = viewportElement();
  if (!viewport) {
    throw new Error('找不到 [data-testid="thread-viewport"]');
  }

  viewport.scrollTop = scrollTop;
  act(() => {
    viewport.dispatchEvent(new Event('scroll'));
  });
}

/** 等若干帧，让被排队的 rAF 跑完（导航帧回调、挂载期钉底都排在这里）。 */
async function flushFrames(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  }
}

function navButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /跳转到消息/ });
}

/**
 * 当前高亮项在导航里的下标。高亮态由 marker 的 class 暴露：只有 active 项拿到
 * `bg-foreground/72`（hover 预览是 `bg-foreground/90`，两者不互相包含）。
 */
function activeNavIndex(): number {
  return navButtons().findIndex((button) =>
    (button.firstElementChild?.className ?? '').includes('bg-foreground/72'),
  );
}

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

/**
 * 挂载长会话，并给视口一组确定几何后结算挂载期排帧。
 *
 * 几何必须显式给：jsdom 不做布局，`scrollHeight/clientHeight` 恒为 0，钉底判定会走
 * 「scrollHeight <= clientHeight」的退化分支，把每次内容变化都当成需要钉底，从而在
 * 帧回调里把测试设好的 `scrollTop` 覆写成 0（照抄 `CodeMuxAssistantRuntime.test.tsx`
 * 的手法）。挂载期钉底本身是真实行为：真实会话首次打开就落在最新一条。
 */
async function mountLongThread(): Promise<HTMLElement> {
  render(<Harness sessionId={NAV_SESSION_ID} />);

  const viewport = viewportElement();
  if (!viewport) {
    throw new Error('找不到 [data-testid="thread-viewport"]');
  }

  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    value: VIEWPORT_SCROLL_HEIGHT,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    value: VIEWPORT_CLIENT_HEIGHT,
  });

  await flushFrames(3);
  return viewport;
}

// ── 1. 纯比较语义 ───────────────────────────────────────────────────────────

function offset(eventIndex: number, top: number): NavOffsetEntry {
  return { eventIndex, top };
}

describe('pickActiveEventIndex', () => {
  it('空缓存返回 null', () => {
    expect(pickActiveEventIndex([], 0, 40)).toBeNull();
  });

  it('取锚点之上最后一条，锚点之上没有时取锚点之下最近的一条', () => {
    const offsets = [offset(0, 0), offset(4, 800), offset(8, 1600)];

    // 锚点 = scrollTop + 40。
    expect(pickActiveEventIndex(offsets, 0, 40)).toBe(0);
    expect(pickActiveEventIndex(offsets, 800, 40)).toBe(4);
    expect(pickActiveEventIndex(offsets, 820, 40)).toBe(4);
    expect(pickActiveEventIndex(offsets, 1560, 40)).toBe(8);
  });

  it('锚点之上全部通过时取遍历顺序里最后一条（与逐条测量一致）；一条都没通过时取最小 top', () => {
    const offsets = [offset(0, 0), offset(4, 800), offset(8, 1600)];

    // 缓存保持导航项顺序，因此「最后一条」就是最后一项。
    expect(pickActiveEventIndex(offsets, 4000, 40)).toBe(8);
    // 乱序输入下仍取遍历顺序里的最后一条 —— 与原实现逐条 `continue` 的语义相同。
    expect(pickActiveEventIndex([...offsets].reverse(), 4000, 40)).toBe(0);
    // 「一条都没通过」的兜底取最小 top，与输入顺序无关（原实现也是比较 top 取最小）。
    expect(pickActiveEventIndex([offset(8, 1600), offset(4, 800)], 0, 40)).toBe(4);
  });

  it('元素缺失被测量事务过滤后，结果与逐条测量时跳过该行一致', () => {
    // 第 0 行（从未渲染过、元素不存在）被 measureNavOffsets 过滤掉：
    // 剩下的行都在锚点之下，因此退回最近的一条，而不是第一条。
    expect(pickActiveEventIndex([offset(4, 800), offset(8, 1600)], 0, 40)).toBe(4);
  });
});

// ── 2. jsdom 集成（长会话） ─────────────────────────────────────────────────

describe('长会话导航高亮只读偏移缓存', () => {
  let restoreLayoutMock: () => void = () => {};

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rowOffsetOverrides.clear();
    layoutReadCount = 0;

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

    const session: Session = {
      id: NAV_SESSION_ID,
      title: '导航偏移缓存',
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
      activeSessionId: NAV_SESSION_ID,
      isLoading: false,
      error: null,
    });

    const events: AgentMessage[] = buildLongSessionEvents(NAV_TURN_COUNT, NAV_SESSION_ID);
    useAgentStore.setState((state) => ({
      events: { ...state.events, [NAV_SESSION_ID]: events },
      eventTimestamps: {
        ...state.eventTimestamps,
        [NAV_SESSION_ID]: events.map((_, index) => index + 1),
      },
      isRunning: { ...state.isRunning, [NAV_SESSION_ID]: false },
      forceStopped: { ...state.forceStopped, [NAV_SESSION_ID]: false },
      streamingText: { ...state.streamingText, [NAV_SESSION_ID]: '' },
      streamingThinking: { ...state.streamingThinking, [NAV_SESSION_ID]: '' },
    }));

    restoreLayoutMock = installLayoutMock();
  });

  afterEach(() => {
    restoreLayoutMock();
    resizeObservers.length = 0;
    layoutReadCount = 0;
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: originalScrollTo,
    });
    cleanup();
  });

  it('首次打开钉底时高亮是最后一轮，滚动中由缓存偏移给出', async () => {
    const viewport = await mountLongThread();

    // 走的是长会话路径：离屏行用 `contain-intrinsic-size` 估算高度参与布局。
    expect(screen.getByTestId('thread-content-shell').hasAttribute('data-long-thread')).toBe(true);
    expect(navButtons()).toHaveLength(NAV_TURN_COUNT);
    // 首次打开钉底（真实会话打开就落在最新一条）：挂载期把视口推到 scrollHeight。
    // 早期行的偏移此时全是 200px 占位 —— 缓存量出的位置必须与视口一致。
    expect(viewport.scrollTop).toBe(VIEWPORT_SCROLL_HEIGHT);
    // jsdom 不会为程序化 scrollTop 赋值派发 scroll 事件（真实浏览器会），手动补一次。
    scrollViewportTo(viewport.scrollTop);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(NAV_TURN_COUNT - 1);

    // 900px 处：锚点 940，第 0..3 轮（0/800/1600/2400）里最后一条通过的是第 1 轮。
    scrollViewportTo(900);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(1);

    scrollViewportTo(2_500);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(3);

    // 回到顶部：回到第 0 轮。
    scrollViewportTo(0);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(0);
  }, 30_000);

  it('一次滚动突发里不再调用 getBoundingClientRect', async () => {
    await mountLongThread();

    // 先向上滚一次让 follow-latest 交出滚动控制权，再结算并丢掉热身读数。
    scrollViewportTo(2_000);
    await flushFrames(2);
    layoutReadCount = 0;

    for (let cycle = 0; cycle < 8; cycle += 1) {
      scrollViewportTo(Math.max(0, (viewportElement()?.scrollTop ?? 0) - ROW_PITCH_PX * 2));
      await flushFrames();
    }

    // 改动前：8 帧 ×（1 次容器 + 40 个导航项）= 328 次，且随会话长度线性增长。
    expect(layoutReadCount).toBe(0);
    // 突发结束在顶部：高亮回到第 0 轮 —— 帧回调确实跑了，只是没读几何。
    expect(activeNavIndex()).toBe(0);
  }, 30_000);

  it('行高变化（ResizeObserver）后重算缓存，不需要滚动', async () => {
    const viewport = await mountLongThread();
    const contentShell = screen.getByTestId('thread-content-shell');

    scrollViewportTo(900);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(1);

    // 第 0、1、2 轮的真实高度远小于 200px 占位（占位被真实高度替换）：之后的偏移整体上移，
    // 第 2 轮（偏移 80）就成了锚点之上最后一条。
    rowOffsetOverrides.set(0, 0);
    rowOffsetOverrides.set(EVENTS_PER_TURN, 40);
    rowOffsetOverrides.set(EVENTS_PER_TURN * 2, 80);

    // 观察者回调就是缓存失效入口：不滚动也要在下一帧换成新几何的答案。
    const shellObservers = resizeObservers.filter((observer) => observer.target === contentShell);
    expect(shellObservers.length).toBeGreaterThan(0);
    act(() => {
      for (const observer of shellObservers) {
        observer.callback([], {} as ResizeObserver);
      }
    });
    await flushFrames(2);

    expect(viewport.scrollTop).toBe(900);
    expect(activeNavIndex()).toBe(2);
  }, 30_000);

  it('点击跳转后缓存被作废：跳转途中的布局变化不会留在缓存里', async () => {
    const viewport = await mountLongThread();

    // 2500px 处：第 3 轮（2400）是锚点之上最后一条。
    scrollViewportTo(2_500);
    await flushFrames(2);
    expect(activeNavIndex()).toBe(3);

    // 跳转途中行高变化（离屏行参与布局）：第 1..3 轮被整体推下去，第 0 轮不动。
    rowOffsetOverrides.set(0, 0);
    rowOffsetOverrides.set(EVENTS_PER_TURN, 8_000);
    rowOffsetOverrides.set(EVENTS_PER_TURN * 2, 16_000);
    rowOffsetOverrides.set(EVENTS_PER_TURN * 3, 24_000);

    const readsBeforeClick = layoutReadCount;
    // 点第 8 项：它既不是重算后的答案（第 0 轮）也不是旧缓存的答案（第 3 轮），
    // 因此「帧回调根本没跑」不会被误判成通过。
    fireEvent.click(navButtons()[7]);
    await flushFrames(2);

    // 点击本身不改滚动位置（scrollTo 在测试里是桩），所以下面只剩「缓存重算过没有」。
    expect(viewport.scrollTop).toBe(2_500);
    // 重算确实发生了一次测量事务。
    expect(layoutReadCount).toBeGreaterThan(readsBeforeClick);
    // 用旧缓存会算成第 3 轮（偏移 2400 已通过锚点）；重算后才是第 0 轮。
    expect(activeNavIndex()).toBe(0);
  }, 30_000);

  // ── 3. 跳转测量作用域的生命周期（工单 02 落点精确性） ──────────────────────

  describe('跳转测量作用域', () => {
    /** 作用域属性：在这里写成字面量，改常量名不会让这组断言静默通过。 */
    const SCOPE_ATTRIBUTE = 'data-thread-measuring';
    /** 落点算式里的常量：让目标行落在容器顶下方 22px。 */
    const JUMP_OFFSET_PX = 22;

    let scrollToSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollToSpy = vi.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value: scrollToSpy,
      });
    });

    it('进入 → 发起滚动 → 飞行期间保持 → scrollend 之后才移除', async () => {
      const viewport = await mountLongThread();
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);

      fireEvent.click(navButtons()[2]);

      // 属性在算落点之前就挂上：算式这才是在稳定坐标系里算的。
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(true);
      // 落点算式没变：目标行顶部（事件下标 × 假行高，减去当前滚动位置）再减 22。
      expect(scrollToSpy).toHaveBeenCalledWith({
        top: userMessageEventIndex(2) * ROW_PITCH_PX - JUMP_OFFSET_PX,
        behavior: 'smooth',
      });

      // 飞行期间保持作用域：与动画同方向、内容高度也没变的一步是动画自己走的，不收尾。
      // （起点在底部，目标在上方 ⇒ 动画方向是 scrollTop 变小。）
      act(() => {
        viewport.scrollTop -= ROW_PITCH_PX;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(true);

      act(() => {
        viewport.dispatchEvent(new Event('scrollend'));
      });
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);
    }, 30_000);

    it('用户手势打断（与动画方向相反、内容高度不变的滚动）立即收尾', async () => {
      const viewport = await mountLongThread();
      fireEvent.click(navButtons()[2]);
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(true);

      // 动画方向是 scrollTop 变小；反向的一步只能来自用户手势（钉底路径用的是同一条归因口径）。
      act(() => {
        viewport.scrollTop += ROW_PITCH_PX;
        viewport.dispatchEvent(new Event('scroll'));
      });

      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);
    }, 30_000);

    it('scrollend 不来时由计时器兜底收尾', async () => {
      const viewport = await mountLongThread();
      // 只假造计时器：挂载与帧回调仍走真实 rAF。
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        fireEvent.click(navButtons()[2]);
        expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(true);

        act(() => {
          vi.advanceTimersByTime(5_000);
        });

        expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    }, 30_000);

    it('卸载时收尾，不把作用域留在 DOM 上', async () => {
      const viewport = await mountLongThread();
      fireEvent.click(navButtons()[2]);
      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(true);

      cleanup();

      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);
    }, 30_000);

    it('短会话不开作用域，但跳转照旧发起', async () => {
      // 短会话：事件数在长会话阈值以下，行级跳过规则不生效，因此不付逃生口的代价。
      const shortEvents = buildLongSessionEvents(3, NAV_SESSION_ID);
      useAgentStore.setState((state) => ({
        events: { ...state.events, [NAV_SESSION_ID]: shortEvents },
      }));

      const viewport = await mountLongThread();
      expect(screen.getByTestId('thread-content-shell').hasAttribute('data-long-thread')).toBe(false);
      expect(navButtons()).toHaveLength(3);

      fireEvent.click(navButtons()[1]);

      expect(viewport.hasAttribute(SCOPE_ATTRIBUTE)).toBe(false);
      expect(scrollToSpy).toHaveBeenCalledTimes(1);
    }, 30_000);
  });
});
