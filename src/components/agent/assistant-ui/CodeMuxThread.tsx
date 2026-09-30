import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  unstable_useThreadMessageIds,
  useAui,
  useAuiState,
  type MessageState,
  type PartState,
} from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import { ArrowDown, FileText, Gauge, Layers, Loader2, MessageSquare, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';
import { createIncrementalBlockParser } from '@/lib/incrementalMarkdownBlocks';

import { MessageFooter, type MessageFooterStats } from '@/components/assistant-ui/message-footer';
import { ActivityStepThinking } from '@/components/assistant-ui/activity-run';
import { SubagentActivityCard } from '@/components/assistant-ui/subagent-activity';
import {
  EMPTY_ACTIVITY_RUNS,
  buildActivityRuns,
  isActivityRunPart,
  type ActivityRunPlacement,
  type ActivityRuns,
} from '@/lib/activityRuns';
import {
  buildRunSubagentActivity,
  runSubagentActivityEqual,
  type SubagentActivity,
} from '@/lib/subagentActivity';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { isSubagentToolName } from '@/lib/subagentTools';
import { useSubagentStore } from '@/stores/subagentStore';
import { useStreamingTextReveal } from './useStreamingTextReveal';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useTokenOutputSpeed } from '@/hooks/useTokenOutputSpeed';
import { Button } from '@/components/ui/button';
import { DotMatrix } from '@/components/ui/dot-matrix';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipHint, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '../../../lib/utils';
import {
  AGENT_REWIND_CAPABILITIES,
  isRewindableUserEvent,
  useAgentStore,
  type AgentMessage,
  type RewindMode,
} from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  reduceThreadWindow,
  resolveMountedTurnStartEventIndex,
  shouldRenderFirstFrameSpacer,
  THREAD_WINDOW_EVENT_THRESHOLD,
  THREAD_WINDOW_GROW_TRIGGER_TOP_PX,
  THREAD_WINDOW_INITIAL_COMMIT_TURNS,
} from '../../../lib/threadWindow';
import { buildConversationTurnIndex, buildConversationTurns } from '../../../lib/conversationTurns';
import type { ConversationTurn, ConversationTurnStatus } from '../../../types/conversationTurn';

import { isCodexCompactSummaryText, isInterruptMarker } from '../../../stores/agentEventParsing';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  CodeMuxDataMessagePart,
  CodeMuxTextMessagePart,
  CodeMuxToolCallMessagePart,
} from './CodeMuxMessageParts';
import {
  AssistantCollapseToggle,
  buildAssistantCollapseInfoMap,
  getCollapseInfoForSourceIndices,
  omitLatestTurnCollapse,
  type AssistantCollapseInfo,
} from './assistantCollapse';
import {
  isLongTranscriptUserMessage,
  shouldShowTranscriptFooter,
  TranscriptUserMessageBubble,
  TranscriptUserMessageExpandButton,
} from './CodeMuxTranscriptMessage';
import { isHiddenAssistantThreadUserEvent } from './assistantResultTargets';
import { RunningElapsedTimer } from './RunningElapsed';
import { ImageAttachmentPreview } from './ImageAttachmentPreview';
import { CODEMUX_FORMATTER, DIRECTIVE_CHIP } from './CodeMuxComposer';

type CodeMuxThreadProps = {
  sessionId: string;
  footer?: ReactNode;
};

export type UserNavItem = {
  eventIndex: number;
  title: string;
  summary: string;
};

type CodeMuxThreadRenderContextValue = {
  sessionId: string;
  compactAiOutput: boolean;
  isRunning: boolean;
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>;
  expandedTurnKeys: Set<string>;
  onToggleExpandedTurn: (turnKey: string) => void;
  /** 处理段投影（连续思考+工具）：分组头已移除，仅用于锚定委派卡片。 */
  activityRuns: ActivityRuns;
  expandedRunKeys: Set<string>;
  claimedRunKeys: Set<string>;
  onToggleRun: (runKey: string, currentlyOpen: boolean) => void;
  /** 处理段里的委派：段 key → 该段的子智能体拓扑（含委派的段才有条目）。 */
  subagentRunActivity: Map<string, SubagentActivity>;
  toolDurations: Record<string, number>;
  turnByEventIndex: Map<number, ConversationTurn<AgentMessage>>;
  turnOrdinalById: Map<string, number>;
  /** While the async subagent flow is unsettled, this is the id of the turn
   * still in flight — that turn's footer waits for settlement. Older turns
   * keep their footers. */
  pendingTurnId?: string;
};

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TURNS: ConversationTurn<AgentMessage>[] = [];
const EMPTY_TIMESTAMPS: number[] = [];
const EMPTY_SUBAGENT_ORDER: string[] = [];
const EMPTY_SUBAGENT_DESCRIPTORS: Record<string, never> = {};
const EMPTY_SUBAGENT_EVENTS: Record<string, never> = {};
const INTERRUPT_LABEL = '用户中断请求';
const MESSAGE_NAV_HIDE_BREAKPOINT = 860;
const THREAD_CONTENT_PADDING_WITH_NAV = 'px-10';
const THREAD_CONTENT_PADDING_WITHOUT_NAV = 'px-5';
/**
 * Above this event count (~60 messages) the transcript is long enough that
 * off-screen rows are worth excluding from layout/paint. See the
 * `[data-long-thread] [data-message-row]` rule in globals.css.
 */
const LONG_THREAD_EVENT_THRESHOLD = 120;
/**
 * 分组头已移除：「处理段」组节点只作为渲染管线的**稳定边界**保留——组把连续的
 * 思考/工具收成一个 key 稳定的子树，流式更新（事件追加、part 状态变化）时工具卡等
 * 部分级组件的实例状态（如展开的工具详情）不会被打掉重挂。渲染层对组**直接透传
 * children**：视觉上完全平铺，没有组头、没有缩进、没有段级开合。
 */
const GROUP_BY_PART = groupPartByType({
  reasoning: ['group-activity-run'],
  'tool-call': ['group-activity-run'],
  'standalone-tool-call': [],
});
const CodeMuxThreadRenderContext = createContext<CodeMuxThreadRenderContextValue | null>(null);

/** Turn layout signature: everything message rows derive from a turn
 * (footer status, duration, event placement, ordinal stability). */
function turnSignatureEqual(a: ConversationTurn<AgentMessage>, b: ConversationTurn<AgentMessage>): boolean {
  return a.id === b.id
    && a.status === b.status
    && a.durationMs === b.durationMs
    && a.footerAnchorEventIndex === b.footerAnchorEventIndex
    && a.eventIndices.length === b.eventIndices.length
    && a.eventIndices.every((index, i) => index === b.eventIndices[i]);
}
const LastMessageIdContext = createContext<string | null>(null);

function useIsLastMessage(message: MessageState): boolean {
  const lastMessageId = useContext(LastMessageIdContext);
  return lastMessageId != null && message.id === lastMessageId;
}

/** Main-thread footer rule: public rule + a completed, non-system turn.
 * Footer suppression is turn-scoped — only the turn still in flight
 * (`turnId === pendingTurnId`) waits for the async subagent flow to settle;
 * older turns keep their footers. */
export function shouldRenderAssistantFooter(input: {
  role: 'assistant' | 'system';
  isFinalAssistantMessage?: boolean;
  turnStatus?: ConversationTurnStatus;
  turnId?: string;
  pendingTurnId?: string;
}): boolean {
  return shouldShowTranscriptFooter({
    role: input.role,
    isFinalAssistantMessage: input.isFinalAssistantMessage,
    isTimelineRunning: false,
  })
    && input.turnStatus === 'completed'
    && input.role !== 'system'
    && input.turnId !== undefined
    && input.turnId !== input.pendingTurnId;
}

/** Bottom margin of an assistant row: rows inside a turn keep a tight rhythm
 * so the process area reads as one block, while the row that ends a turn
 * (footer / collapse head) keeps the larger gap. The row right above the
 * composer keeps only a small tail — the sticky footer adds its own room. */
export function assistantMessageBottomSpacing(input: {
  isLastRow: boolean;
  isToggleMessage: boolean;
  shouldRenderFooter: boolean;
}): string {
  if (input.isLastRow) {
    return 'mb-2';
  }
  // 「已处理」整轮开关是它所领起的那块内容的标题：标题下留 8px 加一条分隔线
  // （见 AssistantCollapseToggle），展开与收起两种状态用同一个值，避免内容跳动。
  if (input.isToggleMessage) {
    return 'mb-2';
  }
  if (input.shouldRenderFooter) {
    return 'mb-4';
  }
  return 'mb-2';
}

const MESSAGE_COMPONENTS = {
  UserMessage: CodeMuxUserMessage,
  UserEditComposer: CodeMuxUserEditComposer,
  AssistantMessage: CodeMuxAssistantMessage,
};

export function CodeMuxThread({ sessionId, footer }: CodeMuxThreadProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const conversationTurns = useAgentStore((state) => state.turns[sessionId] ?? EMPTY_TURNS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  // 尾部挂载窗口（工单 03）：与 provider 用同一套纯函数、同样的输入派生，
  // 两处一致因为输入一致（events.length / turns.length / store 预算）。
  const storedWindowSize = useAgentStore((state) => state.threadWindowSizes[sessionId]);
  const growThreadWindowAction = useAgentStore((state) => state.growThreadWindow);
  const expandThreadWindowToSteady = useAgentStore((state) => state.expandThreadWindowToSteady);
  const resetThreadWindow = useAgentStore((state) => state.resetThreadWindow);
  const windowingActive = events.length > THREAD_WINDOW_EVENT_THRESHOLD;
  const threadWindow = useMemo(
    () =>
      windowingActive
        ? reduceThreadWindow({
            totalTurns: conversationTurns.length,
            windowSize: storedWindowSize ?? THREAD_WINDOW_INITIAL_COMMIT_TURNS,
            initialCommit: storedWindowSize === undefined,
          })
        : { mountedTurns: conversationTurns.length, hiddenAboveTurns: 0, bounded: false },
    [windowingActive, conversationTurns.length, storedWindowSize],
  );
  const mountStartEventIndex = useMemo(
    () =>
      windowingActive && threadWindow.bounded
        ? resolveMountedTurnStartEventIndex(conversationTurns, threadWindow.mountedTurns)
        : 0,
    [windowingActive, threadWindow.bounded, threadWindow.mountedTurns, conversationTurns],
  );
  // 会话切换（视口按 key 重挂载，但本组件不重挂载）时清掉上一会话的预算：
  // 下一次回到该会话重新从首帧语义开始（spec「窗口按 Session 重置」）。
  useEffect(() => {
    return () => resetThreadWindow(sessionId);
  }, [sessionId, resetThreadWindow]);
  // 首帧提交完成后把预算扩到稳态（effect 在首帧绘制之后运行，稳态扩张不付首帧成本）。
  useEffect(() => {
    expandThreadWindowToSteady(sessionId);
  }, [expandThreadWindowToSteady, sessionId, events.length]);
  // 触顶增长与 pre-paint 锚定（spec「首帧与滚动锚定」）。
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingGrowAnchorRef = useRef<number | null>(null);
  const nearBottomRef = useRef(true);
  const windowStateRef = useRef({ active: windowingActive, bounded: threadWindow.bounded });
  windowStateRef.current = { active: windowingActive, bounded: threadWindow.bounded };
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return undefined;
    }
    const handleScroll = () => {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      if (
        windowStateRef.current.active
        && windowStateRef.current.bounded
        && el.scrollTop <= THREAD_WINDOW_GROW_TRIGGER_TOP_PX
      ) {
        // 增长会在阅读位置上方加高度：先记录当前 scrollHeight，layout 阶段按差值修正。
        pendingGrowAnchorRef.current = el.scrollHeight;
        growThreadWindowAction(sessionId);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [growThreadWindowAction, sessionId, viewportRef]);
  // 窗口变化落地后的位置修复（必须在 paint 前的 layout 阶段）：
  // 手工触顶增长用锚点差值把阅读位置钉住；首帧→稳态的自动扩张没有锚点，
  // 用户仍贴底时重新贴底（工单：仅当仍处于贴底状态才重新贴底）。
  const prevWindowSizeRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }
    const current = storedWindowSize ?? THREAD_WINDOW_INITIAL_COMMIT_TURNS;
    const prev = prevWindowSizeRef.current;
    prevWindowSizeRef.current = current;
    if (prev === null || current <= prev) {
      return;
    }
    const anchor = pendingGrowAnchorRef.current;
    if (anchor != null) {
      pendingGrowAnchorRef.current = null;
      const delta = el.scrollHeight - anchor;
      if (delta > 0) {
        el.scrollTop += delta;
      }
    } else if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [storedWindowSize, viewportRef]);
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Set<string>>(() => new Set());
  // 处理段的展开状态：未被用户点过的段跟随 live 自动开合（运行中展开、结束后收起），
  // 用户点过一次之后由用户接管（对齐参考实现的 useAutomaticDisclosure）。
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());
  const [claimedRunKeys, setClaimedRunKeys] = useState<Set<string>>(() => new Set());
  const [showMessageNav, setShowMessageNav] = useState(true);

  useEffect(() => {
    setExpandedTurnKeys(new Set());
    setExpandedRunKeys(new Set());
    setClaimedRunKeys(new Set());
  }, [sessionId, compactAiOutput]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateMessageNavVisibility = () => {
      const width = viewport.clientWidth;
      setShowMessageNav(width === 0 || width >= MESSAGE_NAV_HIDE_BREAKPOINT);
    };

    const handleResize = () => {
      if (document.hidden) {
        return;
      }
      updateMessageNavVisibility();
    };

    updateMessageNavVisibility();

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(handleResize)
      : null;
    observer?.observe(viewport);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        updateMessageNavVisibility();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const toggleExpandedTurn = useCallback((turnKey: string) => {
    setExpandedTurnKeys((current) => {
      const next = new Set(current);
      if (next.has(turnKey)) {
        next.delete(turnKey);
      } else {
        next.add(turnKey);
      }
      return next;
    });
  }, []);

  /** `currentlyOpen` 是这一行当前生效的开合状态：自动展开的段首次被点击要能收起来。 */
  const toggleRun = useCallback((runKey: string, currentlyOpen: boolean) => {
    setClaimedRunKeys((current) => (current.has(runKey) ? current : new Set(current).add(runKey)));
    setExpandedRunKeys((current) => {
      const next = new Set(current);
      if (currentlyOpen) {
        next.delete(runKey);
      } else {
        next.add(runKey);
      }
      return next;
    });
  }, []);

  // Incremental tool duration calculation - only use event-reported durations
  const toolDurationCacheRef = useRef<{ events: AgentMessage[]; result: Record<string, number> }>({ events: [], result: {} });
  const toolDurations = useMemo(() => {
    const cache = toolDurationCacheRef.current;
    if (cache.events === events) {
      return cache.result;
    }
    const prevLen = cache.events.length;
    if (prevLen > 0 && prevLen < events.length && cache.events[0] === events[0]) {
      const newResult = incrementToolDurationMap(cache.result, events, prevLen);
      toolDurationCacheRef.current = { events, result: newResult };
      return newResult;
    }
    const newResult = buildToolDurationMap(events);
    toolDurationCacheRef.current = { events, result: newResult };
    return newResult;
  }, [events]);

  // Turn index caches: turns are rebuilt on every event append, but during a
  // live stream the turn layout rarely changes. Reusing the previous Map (and
  // turn objects) when the turn signatures match keeps the render-context value
  // — and with it every memoized message row — identity-stable.
  const turnIndexCacheRef = useRef<{
    turns: ConversationTurn<AgentMessage>[];
    turnByEventIndex: Map<number, ConversationTurn<AgentMessage>>;
    turnOrdinalById: Map<string, number>;
  }>({ turns: [], turnByEventIndex: new Map(), turnOrdinalById: new Map() });
  const { turnByEventIndex, turnOrdinalById } = useMemo(() => {
    const cache = turnIndexCacheRef.current;
    if (
      cache.turns.length === conversationTurns.length
      && cache.turns.every((turn, index) => (
        turn === conversationTurns[index]
        || turnSignatureEqual(turn, conversationTurns[index])
      ))
    ) {
      return cache;
    }
    const next = {
      turns: conversationTurns,
      turnByEventIndex: buildConversationTurnIndex(conversationTurns),
      turnOrdinalById: new Map(conversationTurns.map((turn, index) => [turn.id, index])),
    };
    turnIndexCacheRef.current = next;
    return next;
  }, [conversationTurns]);
  const sessionHasSubagents = useSubagentStore((state) => (state.sessions[sessionId]?.order.length ?? 0) > 0);
  const runningSubagentCount = useSubagentStore((state) => {
    const session = state.sessions[sessionId];
    if (!session) return 0;
    return session.order.reduce(
      (count, id) => count + (session.descriptors[id]?.status === 'running' ? 1 : 0),
      0,
    );
  });
  const hasRunningSubagents = runningSubagentCount > 0;
  // Continuation turns stream without a sendInput, so isRunning alone misses
  // them — the streaming buffers cover that window. Only the *presence* of a
  // buffer matters here, so derive that boolean inside the selector instead of
  // subscribing to the buffer text. The text changes on every streaming flush
  // (tens of times per second, up to 16k chars per answer), and subscribing to
  // it re-rendered this whole thread tree — message nav, footer and the message
  // list wrapper — just to recompute a flag that only flips when a stream
  // starts or stops. A derived boolean makes those flushes free here.
  const hasStreamingBuffer = useAgentStore(
    (state) =>
      (state.streamingText[sessionId]?.length ?? 0) > 0
      || (state.streamingThinking[sessionId]?.length ?? 0) > 0,
  );
  // Children all terminal but the parent's summary turn has not settled yet:
  // the flow is still running from the user's point of view.
  const continuationPending = useSubagentStore((state) => state.continuationPending[sessionId] ?? false);
  const subagentFlowPending = sessionHasSubagents
    && (hasRunningSubagents || isRunning || continuationPending || hasStreamingBuffer);
  // Footer suppression is turn-scoped: only the turn still in flight waits
  // for the async subagent flow to settle; completed turns keep their footers.
  const pendingTurnId = subagentFlowPending && conversationTurns.length > 0
    ? conversationTurns[conversationTurns.length - 1]?.id
    : undefined;
  const userNavItems = useMemo(() => {
    const all = buildUserNavItems(events);
    // 只为已挂载的行生成标记（绝对下标过滤，标记本身不变）；
    // 被扣掉的历史由「更早历史」延续标记表达。
    return mountStartEventIndex > 0
      ? all.filter((item) => item.eventIndex >= mountStartEventIndex)
      : all;
  }, [events, mountStartEventIndex]);
  const userMessageCount = useMemo(
    () => events.reduce((count, event) => count + (event.kind === 'user' ? 1 : 0), 0),
    [events],
  );
  const collapseCacheRef = useRef<{
    events: AgentMessage[];
    timestamps: number[];
    flags: string;
    map: Map<number, AssistantCollapseInfo>;
  }>({ events: [], timestamps: [], flags: '', map: new Map() });
  const collapseInfoByEventIndex = useMemo(() => {
    const cache = collapseCacheRef.current;
    const flags = `${isRunning}|${stopped}|${subagentFlowPending}`;
    if (
      cache.events === events
      && cache.timestamps === eventTimestamps
      && cache.flags === flags
    ) {
      return cache.map;
    }
    const map = buildAssistantCollapseInfoMap(events, eventTimestamps, {
      allowImplicitResult: !isRunning && !stopped,
    });
    // While the async subagent flow is unsettled the latest turn must keep
    // looking alive — collapsing it into "已处理 32s" reads as finished even
    // though background children are still running.
    const finalMap = subagentFlowPending ? omitLatestTurnCollapse(map, events) : map;
    // Reuse the previous map reference when entries are equivalent so the
    // render-context value stays stable across unrelated event appends.
    if (
      cache.map.size === finalMap.size
      && [...finalMap].every(([index, info]) => {
        const prev = cache.map.get(index);
        return prev != null
          && prev.turnKey === info.turnKey
          && prev.isToggleMessage === info.isToggleMessage
          && prev.durationMs === info.durationMs
          && prev.hideReasoningOnly === info.hideReasoningOnly
          && prev.stepCount === info.stepCount
          && prev.hasError === info.hasError;
      })
    ) {
      collapseCacheRef.current = { events, timestamps: eventTimestamps, flags, map: cache.map };
      return cache.map;
    }
    collapseCacheRef.current = { events, timestamps: eventTimestamps, flags, map: finalMap };
    return finalMap;
  }, [events, eventTimestamps, isRunning, stopped, subagentFlowPending]);

  // 处理段（连续思考+工具）的分段、计时与实时状态。
  const activityRuns = useMemo(
    () => (events.length === 0
      ? EMPTY_ACTIVITY_RUNS
      : buildActivityRuns(events, conversationTurns, eventTimestamps, { isRunning })),
    [events, conversationTurns, eventTimestamps, isRunning],
  );
  // 委派（Task/Agent）：每个处理段里起了哪些子智能体、它们各自的进度。
  // 段头据此改画委派卡片；不含委派的段仍是普通组头。
  const sessionSubagents = useSubagentStore((state) => state.sessions[sessionId]);
  // 委派投影在渲染等价时复用上一张表。子智能体每吐一个 delta，store 就换一次时间线
  // 数组身份；不比较的话 `threadRenderContextValue` 每来一个字换一次身份，主线程每一行
  // 已挂载消息都要重新协调（实测 24 行→41 次行渲染，120 行→201 次），主线程被占满后
  // 连两个每秒推进的计时器都跟着停跳。比较口径见 `subagentActivityEqual`。
  const subagentActivityCacheRef = useRef<Map<string, SubagentActivity>>(new Map());
  const subagentRunActivity = useMemo(() => {
    const next = buildRunSubagentActivity({
      runs: activityRuns.runs,
      agentEvents: events,
      order: sessionSubagents?.order ?? EMPTY_SUBAGENT_ORDER,
      descriptors: sessionSubagents?.descriptors ?? EMPTY_SUBAGENT_DESCRIPTORS,
      subagentEvents: sessionSubagents?.events ?? EMPTY_SUBAGENT_EVENTS,
    });
    const previous = subagentActivityCacheRef.current;
    if (runSubagentActivityEqual(previous, next)) {
      return previous;
    }
    subagentActivityCacheRef.current = next;
    return next;
  }, [activityRuns, events, sessionSubagents]);

  const threadRenderContextValue = useMemo(() => ({
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    onToggleExpandedTurn: toggleExpandedTurn,
    activityRuns,
    expandedRunKeys,
    claimedRunKeys,
    onToggleRun: toggleRun,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
    subagentRunActivity,
  }), [
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    toggleExpandedTurn,
    activityRuns,
    expandedRunKeys,
    claimedRunKeys,
    toggleRun,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
    subagentRunActivity,
  ]);

  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col text-sm">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <UnifiedThreadViewport
          key={sessionId}
          sessionId={sessionId}
          eventCount={events.length}
          userMessageCount={userMessageCount}
          isRunning={isRunning}
          runningSubagentCount={runningSubagentCount}
          viewportRef={viewportRef}
        >
          {(scrollToBottomButton) => (
            <div
              data-testid="thread-content-shell"
              data-long-thread={events.length > LONG_THREAD_EVENT_THRESHOLD ? '' : undefined}
              className={cn(
                'mx-auto flex w-full flex-1 flex-col pt-4',
                showMessageNav ? THREAD_CONTENT_PADDING_WITH_NAV : THREAD_CONTENT_PADDING_WITHOUT_NAV,
              )}
              style={{ maxWidth: 'var(--content-width, 52rem)' }}
            >
              {shouldRenderFirstFrameSpacer({
                bounded: threadWindow.bounded,
                windowSize: storedWindowSize ?? THREAD_WINDOW_INITIAL_COMMIT_TURNS,
              }) ? (
                <div aria-hidden className="thread-window-spacer" data-testid="thread-window-spacer" />
              ) : null}
              <CodeMuxThreadRenderContext.Provider value={threadRenderContextValue}>
                <CodeMuxThreadMessages />
              </CodeMuxThreadRenderContext.Provider>
              {stopped ? <InterruptBanner /> : null}
              <StreamingContent sessionId={sessionId} events={events} />
              <ThreadPrimitive.ViewportFooter
                data-testid="thread-viewport-footer"
                className="sticky bottom-0 mt-auto z-10 flex flex-col gap-2 overflow-visible bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] pt-1 pb-3"
              >
                {scrollToBottomButton}
                {footer}
              </ThreadPrimitive.ViewportFooter>
            </div>
          )}
        </UnifiedThreadViewport>
        {showMessageNav ? (
          <MessageNav
            items={userNavItems}
            scrollContainer={viewportRef}
            disabled={isRunning}
            earlierHistoryTurns={threadWindow.hiddenAboveTurns}
            onGrowEarlier={() => growThreadWindowAction(sessionId)}
          />
        ) : null}
      </div>
    </ThreadPrimitive.Root>
  );
}

function UnifiedThreadViewport({
  sessionId,
  eventCount,
  userMessageCount,
  isRunning,
  runningSubagentCount,
  viewportRef,
  children,
}: {
  sessionId: string;
  eventCount: number;
  userMessageCount: number;
  isRunning: boolean;
  /** Subagent start/finish changes timeline height (status chips, the
   * background-running row) without emitting parent events; include it so
   * follow-latest keeps firing through a quiet parent window. */
  runningSubagentCount: number;
  viewportRef: RefObject<HTMLDivElement>;
  children: (scrollToBottomButton: ReactNode) => ReactNode;
}) {
  // 首次非空渲染可能来自已缓存历史，也需要等 assistant-ui 提交消息树。
  const previousEventCountRef = useRef(0);
  const previousUserMessageCountRef = useRef(0);
  const isHistoryHydration = previousEventCountRef.current === 0 && eventCount > 0;
  const hasNewUserMessage = userMessageCount > previousUserMessageCountRef.current;
  // streamingVersion is deliberately not part of followKey: the hook subscribes
  // to it imperatively, because re-rendering this viewport (and the whole thread
  // subtree it wraps) on every streaming flush only to schedule a scroll was one
  // of the largest per-flush costs.
  const { isAtBottom, scrollToBottom } = useTranscriptFollowLatest({
    viewportRef,
    followKey: `${sessionId}:${eventCount}:${isRunning ? '1' : '0'}:${userMessageCount}:${runningSubagentCount}`,
    extraFrames: isHistoryHydration || hasNewUserMessage ? 2 : 1,
    forceFollow: hasNewUserMessage,
    followSessionId: sessionId,
  });

  useEffect(() => {
    previousEventCountRef.current = eventCount;
    previousUserMessageCountRef.current = userMessageCount;
  }, [eventCount, userMessageCount]);

  const scrollToBottomButton = (
    <ScrollToBottomButton
      isAtBottom={isAtBottom}
      onScrollToBottom={scrollToBottom}
    />
  );

  return (
    <ThreadPrimitive.ViewportProvider>
      <div
        ref={viewportRef}
        data-testid="thread-viewport"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-scroll scrollbar-gutter-stable"
      >
        {children(scrollToBottomButton)}
      </div>
    </ThreadPrimitive.ViewportProvider>
  );
}

function ScrollToBottomButton({
  isAtBottom,
  onScrollToBottom,
}: {
  isAtBottom: boolean;
  onScrollToBottom: () => void;
}) {
  return (
    <TooltipHint content="滚动到底部">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="absolute -top-12 left-1/2 z-10 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-[hsl(var(--surface-2))] text-muted-foreground shadow-[0_8px_30px_-16px_hsl(var(--surface-shadow-strong)/0.35)] transition-all hover:-translate-y-0.5 hover:bg-[hsl(var(--surface-3))] hover:text-foreground disabled:invisible"
        data-testid="scroll-to-bottom"
        aria-label="滚动到底部"
        disabled={isAtBottom}
        onClick={onScrollToBottom}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </TooltipHint>
  );
}

function CodeMuxThreadMessages() {
  const messageIds = unstable_useThreadMessageIds();
  const lastMessageId = messageIds.length > 0 ? messageIds[messageIds.length - 1] : null;

  return (
    <LastMessageIdContext.Provider value={lastMessageId}>
      {messageIds.map((messageId) => (
        <ThreadPrimitive.Unstable_MessageById
          key={messageId}
          messageId={messageId}
          components={MESSAGE_COMPONENTS}
        />
      ))}
    </LastMessageIdContext.Provider>
  );
}

function useCodeMuxThreadRenderContext() {
  const value = useContext(CodeMuxThreadRenderContext);
  if (!value) {
    throw new Error('CodeMux thread message components must be rendered inside CodeMuxThreadRenderContext.');
  }
  return value;
}

function showRewindResultToast(mode: RewindMode, filesChanged?: number) {
  if (mode === 'files') {
    toast.success(`已回退 ${filesChanged ?? 0} 个文件`);
    return;
  }
  if (mode === 'both') {
    const count = filesChanged ?? 0;
    if (count > 0) {
      toast.success(`已回退对话和 ${count} 个文件`);
      return;
    }
    toast.success('对话已回退');
    toast.warning('该消息没有可回退的文件变更');
  }
}

function CodeMuxUserMessage() {
  const message = useAuiState((state) => state.message);
  const { sessionId, isRunning } = useCodeMuxThreadRenderContext();
  const rewindToMessage = useAgentStore((state) => state.rewindToMessage);
  const requestComposerRestore = useAgentStore((state) => state.requestComposerRestore);
  const sourceEventIndex = getSourceEventIndex(message);
  const event = useAgentStore((state) => {
    const list = state.events[sessionId] ?? EMPTY_EVENTS;
    return sourceEventIndex != null ? list[sourceEventIndex] : undefined;
  });
  const agentKind = useSessionStore((state) =>
    (state.sessions.find((session) => session.id === sessionId)
      ?? state.archivedSessions.find((session) => session.id === sessionId))?.agent_kind,
  );
  const isReadOnly = useSessionStore((state) =>
    (state.sessions.find((session) => session.id === sessionId)
      ?? state.archivedSessions.find((session) => session.id === sessionId))?.is_read_only ?? false,
  );
  const [isRewinding, setIsRewinding] = useState(false);
  const rewindModes: RewindMode[] = agentKind
    ? (['conversation', 'files', 'both'] as const).filter((mode) => AGENT_REWIND_CAPABILITIES[agentKind][mode])
    : [];
  const rewindableUser = event != null && isRewindableUserEvent(event);

  // 行的比较器只能看到传进去的值，所以派生一律在这里做完：渲染与比较用的是同一份来源。
  const text = getMessageText(message);
  const timestamp = getSourceTimestamp(message);
  const imageAttachments = getImageAttachmentItems(message);
  const handleRewindToMessage = useCallback(async (mode: RewindMode) => {
    if (sourceEventIndex == null || isRewinding) {
      return;
    }
    setIsRewinding(true);
    try {
      const result = await rewindToMessage(sessionId, sourceEventIndex, mode);
      if (!result) {
        toast.warning('当前无法回退：会话正在运行或该消息不可回退');
        return;
      }
      showRewindResultToast(mode, result.filesChanged);
      if (mode !== 'files' && result.text.trim().length > 0) {
        requestComposerRestore(sessionId, result.text);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '回退失败，请重试');
    } finally {
      setIsRewinding(false);
    }
  }, [sourceEventIndex, isRewinding, rewindToMessage, sessionId, requestComposerRestore]);
  return (
    <UserMessage
      text={text}
      timestamp={timestamp}
      imageAttachments={imageAttachments}
      sourceEventIndex={sourceEventIndex}
      canRewind={rewindModes.length > 0 && rewindableUser && !isRunning && !isReadOnly}
      isRewinding={isRewinding}
      rewindModes={rewindModes}
      onRewindToMessage={handleRewindToMessage}
    />
  );
}

function CodeMuxUserEditComposer() {
  const message = useAuiState((state) => state.message);
  return <UserEditComposer message={message} sourceEventIndex={getSourceEventIndex(message)} />;
}

function CodeMuxAssistantMessage() {
  const message = useAuiState((state) => state.message);
  const isLastMessage = useIsLastMessage(message);
  const {
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    expandedRunKeys,
    claimedRunKeys,
    onToggleExpandedTurn,
    onToggleRun,
    activityRuns,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
    subagentRunActivity,
  } = useCodeMuxThreadRenderContext();

  /**
   * 这一层是**故意**跟着 context 每次更新重渲染的：它很便宜（一次派生 + 一次 memo 子节点的协调），
   * 真正贵的是行内容。行内容交给下面的 `memo(AssistantLikeMessage)` 按 `bindings` 判断要不要重画——
   * 必须在这里派生一次再传进去，比较器才有东西可比（见 `deriveAssistantRowBindings` 的注释）。
   */
  const bindings = deriveAssistantRowBindings({
    message,
    isLastMessage,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    expandedRunKeys,
    claimedRunKeys,
    activityRuns,
    subagentRunActivity,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
  });

  return (
    <AssistantLikeMessage
      message={message}
      sessionId={sessionId}
      bindings={bindings}
      onToggleExpandedTurn={onToggleExpandedTurn}
      onToggleRun={onToggleRun}
    />
  );
}

function InterruptBanner() {
  return (
    <div className="mb-3 flex w-full justify-center">
      <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {INTERRUPT_LABEL}
      </div>
    </div>
  );
}

type UserRowProps = {
  /** 正文：由外层派生（与渲染用的是同一份，见 `areUserRowPropsEqual`）。 */
  text: string;
  timestamp?: number;
  imageAttachments: Array<{ id: string; name: string; src: string }>;
  sourceEventIndex?: number;
  canRewind?: boolean;
  isRewinding?: boolean;
  rewindModes?: RewindMode[];
  onRewindToMessage?: (mode: RewindMode) => Promise<void> | void;
};

/**
 * 一行用户消息。
 *
 * 它自己只订阅 `{ sessionId, isRunning }`，但 context 的值每次事件追加都会换身份，所以这一行原来
 * 也会**每来一个事件就重渲染一次**（实测：挂载 120 行时追加一个事件会产生 201 次行渲染）。派生值
 * 一律由外层算好传进来，这里只按这些值比较——`memo` 的作用就是把"context 变了"与"这一行要重画"
 * 分开。
 */
const UserMessage = memo(function UserMessage({
  text,
  timestamp,
  imageAttachments,
  sourceEventIndex,
  canRewind,
  isRewinding = false,
  rewindModes = [],
  onRewindToMessage,
}: UserRowProps) {
  const [expanded, setExpanded] = useState(false);
  // 窄屏没有 hover:用户消息 footer(时间/复制/回退)常显。
  const isNarrow = useIsNarrowViewport();
  const canCollapse = isLongTranscriptUserMessage(text);
  const rewindTooltip = '回退到此消息';
  const handleRewindSelect = (mode: RewindMode) => {
    if (isRewinding) {
      return;
    }
    void onRewindToMessage?.(mode);
  };

  if (!text && imageAttachments.length === 0) {
    return null;
  }

  if (isInterruptMarker(text)) {
    return (
      <div className="mb-3 flex w-full justify-center">
        <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {INTERRUPT_LABEL}
        </div>
      </div>
    );
  }

  return (
    <MessagePrimitive.Root
      id={sourceEventIndex != null ? `msg-${sourceEventIndex}` : undefined}
      data-message-row
      className="group/message-row mb-2.5 flex w-full justify-end"
    >
      <div data-user-message-column="true" className="flex w-fit max-w-10/12 min-w-0 flex-col items-end">
        {imageAttachments.length > 0 ? (
          <div className={cn('mb-2 flex max-w-[18.5rem] flex-row-reverse flex-wrap gap-2', text.length === 0 && 'mb-0')}>
            {imageAttachments.map((attachment) => (
              <ImageAttachmentPreview
                key={attachment.id}
                src={attachment.src}
                alt={attachment.name}
                thumbnailClassName="h-20 w-20 rounded-md"
              />
            ))}
          </div>
        ) : null}
        {text ? (
          <TranscriptUserMessageBubble text={text} expanded={expanded} canCollapse={canCollapse} />
        ) : null}
        {canCollapse ? (
          <TranscriptUserMessageExpandButton
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        <div
          className={cn(
            'flex items-center justify-end gap-1 transition-opacity duration-fast',
            isNarrow
              ? 'opacity-100'
              : 'opacity-0 group-focus-within/message-row:opacity-100 group-hover/message-row:opacity-100',
          )}
        >
          <MessageFooter timestamp={timestamp} className="justify-end" revealOnHover />
          {canRewind ? (
            <DropdownMenu>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={rewindTooltip}
                      disabled={isRewinding}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ui-body text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    >
                      {isRewinding ? <Loader2 className="size-[1em] animate-spin" /> : <Undo2 className="size-[1em]" />}
                    </Button>
                  </TooltipTrigger>
                </DropdownMenuTrigger>
                <TooltipContent side="top">{rewindTooltip}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" side="bottom" className="min-w-44">
                <div className="px-2.5 pb-1.5 pt-1.5 text-xs text-muted-foreground">
                  此操作无法撤销
                </div>
                {rewindModes.includes('conversation') ? (
                  <DropdownMenuItem icon={<MessageSquare className="size-[1em]" />} onSelect={() => handleRewindSelect('conversation')}>
                    回退对话
                  </DropdownMenuItem>
                ) : null}
                {rewindModes.includes('files') ? (
                  <DropdownMenuItem icon={<FileText className="size-[1em]" />} onSelect={() => handleRewindSelect('files')}>
                    回退文件
                  </DropdownMenuItem>
                ) : null}
                {rewindModes.includes('both') ? (
                  <DropdownMenuItem icon={<Layers className="size-[1em]" />} onSelect={() => handleRewindSelect('both')}>
                    回退对话和文件
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}, areUserRowPropsEqual);

/**
 * 用户行的比较器：逐项比较**渲染真正用到的值**。
 *
 * `rewindModes` 与 `imageAttachments` 每次派生都是新数组，所以按元素比**内容**而不是比身份；
 * 其余都是标量或稳定引用。`message` 本身不参与比较——它的取值等价性已经由 `text` / `timestamp` /
 * `imageAttachments` 三项完整表达（这也是行体唯一从 message 取的东西）。
 */
function areUserRowPropsEqual(prev: UserRowProps, next: UserRowProps): boolean {
  if (prev.text !== next.text
    || prev.timestamp !== next.timestamp
    || prev.sourceEventIndex !== next.sourceEventIndex
    || prev.canRewind !== next.canRewind
    || prev.isRewinding !== next.isRewinding
    || prev.onRewindToMessage !== next.onRewindToMessage) {
    return false;
  }

  const modesPrev = prev.rewindModes ?? [];
  const modesNext = next.rewindModes ?? [];
  if (modesPrev.length !== modesNext.length) return false;
  for (let index = 0; index < modesPrev.length; index += 1) {
    if (modesPrev[index] !== modesNext[index]) return false;
  }

  const attachmentsPrev = prev.imageAttachments;
  const attachmentsNext = next.imageAttachments;
  if (attachmentsPrev.length !== attachmentsNext.length) return false;
  for (let index = 0; index < attachmentsPrev.length; index += 1) {
    const before = attachmentsPrev[index];
    const after = attachmentsNext[index];
    if (before.id !== after.id || before.name !== after.name || before.src !== after.src) {
      return false;
    }
  }
  return true;
}

function UserEditComposer({ message, sourceEventIndex }: { message: MessageState; sourceEventIndex?: number }) {
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const canSend = text.trim().length > 0;
  const cancelEdit = () => {
    aui.message().composer().cancel();
  };
  const sendEdit = () => {
    if (!canSend) {
      return;
    }

    const msgParentId = message.parentId;
    const msgId = message.id;
    const msgText = text;

    flushSync(() => {
      aui.message().composer().cancel();
    });
    window.setTimeout(() => {
      // Use the public API with parentId = message's own ID as fallback
      // to prevent toAppendMessage from replacing null parentId with
      // the last message's ID, which would break the isEdit check in the core.
      aui.thread().append({
        parentId: msgParentId ?? msgId,
        sourceId: msgId,
        role: 'user',
        content: msgText ? [{ type: 'text', text: msgText }] : [],
        attachments: [],
        createdAt: new Date(),
      });
    }, 0);
  };

  return (
    <MessagePrimitive.Root
      id={sourceEventIndex != null ? `msg-${sourceEventIndex}` : undefined}
      className="mb-3 flex w-full justify-end"
    >
      <ComposerPrimitive.Root
        onSubmit={(event) => {
          event.preventDefault();
          sendEdit();
        }}
        className="flex w-full max-w-[min(42rem,100%)] justify-end"
      >
        <div className="w-full rounded-xl rounded-tr-md bg-muted p-3 shadow-[0_12px_30px_-24px_hsl(var(--foreground)/0.42)]">
          <LexicalComposerInput
            submitMode="enter"
            autoFocus
            directiveChip={DIRECTIVE_CHIP}
            formatter={CODEMUX_FORMATTER}
            className="relative min-h-18 max-h-52 w-full overflow-y-auto text-sm leading-6 text-foreground outline-none [&_.aui-lexical-input]:min-h-18 [&_.aui-lexical-input]:max-h-52 [&_.aui-lexical-input]:overflow-y-auto [&_.aui-lexical-input]:border-0 [&_.aui-lexical-input]:bg-transparent [&_.aui-lexical-input]:px-0 [&_.aui-lexical-input]:py-0 [&_.aui-lexical-input]:text-sm [&_.aui-lexical-input]:leading-6 [&_.aui-lexical-input]:text-foreground [&_.aui-lexical-input]:shadow-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-input]:ring-0 [&_.aui-lexical-input]:focus-visible:outline-none"
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg px-3" onClick={cancelEdit}>
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSend}
              className="h-8 rounded-lg px-3"
              onClick={(event) => {
                event.preventDefault();
                sendEdit();
              }}
            >
              发送
            </Button>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function getImageAttachmentItems(message: MessageState): Array<{ id: string; name: string; src: string }> {
  return (message.attachments ?? [])
    .filter((attachment) => attachment.type === 'image')
    .flatMap((attachment, index) => {
      const imagePart = attachment.content?.find((part) => part.type === 'image') as { type: 'image'; image?: string } | undefined;
      if (!imagePart?.image) {
        return [];
      }

      return [{
        id: `${attachment.id}-${index}`,
        name: attachment.name,
        src: imagePart.image,
      }];
    });
}

/**
 * 导航条标记必须与正文同源：正文里被隐藏的「协议回声」（压缩摘要、`/compact`、
 * 本地命令回声、工具结果回填）没有用户气泡，因此也不该有标记。判定直接复用正文
 * 那一条（`isHiddenAssistantThreadUserEvent`），避免两边口径再次漂移。
 */
export function buildUserNavItems(events: AgentMessage[]): UserNavItem[] {
  const userIndexes: number[] = [];

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event.kind !== 'user') continue;

    const text = typeof event.data.content === 'string' ? event.data.content.trim() : '';
    if (text.length === 0 || isInterruptMarker(text) || isHiddenAssistantThreadUserEvent(event)) {
      continue;
    }

    userIndexes.push(eventIndex);
  }

  return userIndexes.map((eventIndex, index) => {
    const event = events[eventIndex];
    const text = event.kind === 'user' ? event.data.content : '';
    return {
      eventIndex,
      title: extractUserNavTitle(text),
      summary: extractAssistantNavSummary(events, eventIndex, userIndexes[index + 1]),
    };
  });
}

export function extractUserNavTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => cleanNavText(line))
    .find((line) => line.length > 0) ?? '用户消息';

  return firstLine;
}

export function extractAssistantNavSummary(
  events: AgentMessage[],
  userIndex: number,
  nextUserIndex?: number,
): string {
  const endIndex = nextUserIndex ?? events.length;
  let lastAssistantText = '';

  for (let index = userIndex + 1; index < endIndex; index++) {
    const event = events[index];
    if (event.kind !== 'assistant') continue;

    const text = extractAssistantText(event);
    // 自动压缩的摘要以 assistant 事件落盘，但它不是这一轮的回答：让它当摘要会把整段
    // 压缩总结塞进导航预览（正文里它同样被隐藏，只留压缩样式标记）。
    if (text && !isCodexCompactSummaryText(text)) {
      lastAssistantText = text;
    }
  }

  return truncateNavText(cleanNavText(lastAssistantText), 90);
}

export function cleanNavText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
    .replace(/<usage>[\s\S]*?<\/usage>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_~>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAssistantText(event: Extract<AgentMessage, { kind: 'assistant' }>): string {
  const content: unknown = event.data.message?.content;

  if (typeof content === 'string') {
    return content.trim() === 'No response requested.' ? '' : content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== 'No response requested.',
    )
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function truncateNavText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * 导航标记的静止态宽度（没有悬停预览时）。非当前项过去只有 6px，作为「未激活」的
 * 默认态显得太短；当前项仍比它长 2px，保留「当前项更粗」的一眼可辨。
 */
const NAV_MARKER_RESTING_WIDTH = 10;
const NAV_MARKER_ACTIVE_WIDTH = 12;

/**
 * 悬停山形尾部（距预览项 ≥3）的宽度：必须高于静止态，否则一悬停，远处那些原本
 * 10px 的标记会缩回去，整条导航先抖一下。
 */
const NAV_MARKER_HOVER_TAIL_WIDTH = 11;

function getMessageNavMarkerWidth(
  itemIndex: number,
  previewItemIndex: number | null,
  isActive: boolean,
): number {
  if (previewItemIndex == null || previewItemIndex < 0) {
    return isActive ? NAV_MARKER_ACTIVE_WIDTH : NAV_MARKER_RESTING_WIDTH;
  }

  const distance = Math.abs(itemIndex - previewItemIndex);
  if (distance === 0) return 34;
  if (distance === 1) return 22;
  if (distance === 2) return 14;
  return NAV_MARKER_HOVER_TAIL_WIDTH;
}

/** 导航高亮的锚点：滚动容器顶往下 40px（与原实现一致）。 */
const NAV_ACTIVE_ANCHOR_OFFSET_PX = 40;

/**
 * 跳转期间的测量作用域属性：规则见 `src/styles/globals.css` 里的同名选择器。
 *
 * 它是逃生口而不是装饰 —— 长会话里有两层嵌套的跳过渲染（`[data-long-thread] [data-message-row]`
 * 与 streamdown 打在代码块上的内联 `content-visibility`），从未布局过的行/代码块用占位高度参与
 * 布局，跳转的落点算式就只能在虚高的坐标系里算落点（实测偏到目标行上方约 340px）。
 * 挂上它之后两层一起变成真实布局：坐标系在发起滚动前稳定，并在飞行期间保持稳定。
 */
const MEASURING_SCOPE_ATTRIBUTE = 'data-thread-measuring';
/**
 * 落定兜底：`scrollend` 在动画被取消等情况下可能不来，超时也必须摘掉作用域 ——
 * 绝不允许把作用域永久留在 DOM 上（那等于放弃跳过渲染的收益）。
 */
const MEASURING_SCOPE_TIMEOUT_MS = 2000;

/** 一条导航项的缓存偏移：与 `scrollTop` 同一坐标系（相对滚动内容顶部）。 */
export interface NavOffsetEntry {
  eventIndex: number;
  /** 该行顶部相对滚动内容顶部的距离（px）。 */
  top: number;
}

/**
 * 测量事务：一次性量出全部导航项相对滚动内容顶部的偏移。
 *
 * 这是导航高亮路径上**唯一**允许读布局几何的地方。滚动期间的每一帧只比较缓存，
 * 不再逐项 `getElementById` + `getBoundingClientRect`（一次滚动突发里后者是
 * 「1 次容器 + 每个导航项各一次」× 帧数）。源码契约断言见
 * `CodeMuxThread.navActiveSource.test.ts`。
 */
export function measureNavOffsets(
  container: HTMLElement,
  items: readonly UserNavItem[],
): NavOffsetEntry[] {
  const containerTop = container.getBoundingClientRect().top;
  const scrollTop = container.scrollTop;
  const offsets: NavOffsetEntry[] = [];

  for (const item of items) {
    const element = document.getElementById(`msg-${item.eventIndex}`);
    if (!element) {
      continue;
    }

    // 换算成内容坐标系：滚动位置变化不会让它失效，因此缓存只需在布局变化时重算。
    offsets.push({
      eventIndex: item.eventIndex,
      top: element.getBoundingClientRect().top - containerTop + scrollTop,
    });
  }

  return offsets;
}

/**
 * 滚动期的热循环：只读缓存偏移与滚动位置，不读任何布局几何。
 *
 * 判定顺序与原先「逐条测量」时逐个比较的结果一致：先取锚点之上最后一条，
 * 没有则取锚点之下最近的一条，都没有则退回第一条。
 */
export function pickActiveEventIndex(
  offsets: readonly NavOffsetEntry[],
  scrollTop: number,
  anchorOffsetPx: number,
): number | null {
  if (offsets.length === 0) {
    return null;
  }

  const anchor = scrollTop + anchorOffsetPx;
  let lastPassed: number | null = null;
  let nextUpcoming: NavOffsetEntry | null = null;

  for (const offset of offsets) {
    if (offset.top <= anchor) {
      lastPassed = offset.eventIndex;
      continue;
    }

    if (nextUpcoming === null || offset.top < nextUpcoming.top) {
      nextUpcoming = offset;
    }
  }

  return lastPassed ?? nextUpcoming?.eventIndex ?? offsets[0]?.eventIndex ?? null;
}

/**
 * 进入跳转测量作用域：给滚动容器挂上 `data-thread-measuring`（规则见 `globals.css` 的同名选择器）。
 *
 * 为什么需要：跳转的落点算式读的是**当前布局**，而长会话里有两层嵌套的跳过渲染 ——
 *   1. `[data-long-thread] [data-message-row]`：从未渲染过的行只有 200px 占位；
 *   2. streamdown 打在代码块上的内联 `content-visibility`：从未布局过的代码块按占位算约 202px，
 *      真实高度约 90px（每块虚高 112.5px，实测整个会话虚高 4950px）。
 * 于是算式在虚高的坐标系里算出落点，动画途中被途经渲染的行/代码块一塌到真实高度就把目标行
 * 往上带（实测落点停在目标行上方约 340px）。作用域把两层一起中和，并在这里**强制一次布局**：
 * 读 `scrollHeight` 之后浏览器已按作用域样式重排，坐标系从此稳定，可以据此算落点。
 *
 * 返回是否真的开了作用域：短会话不受行级跳过规则影响，按「短会话行为与现状等价」的约束不动它
 * （作用域挂上/摘掉本身不影响短会话的落点，但没必要为它付一次全量布局与 2s 的计时器）。
 */
function openMeasuringScope(container: HTMLDivElement): boolean {
  // 线程壳是滚动容器的第一个元素子节点（`measureNavOffsets` 的 ResizeObserver 也按这个口径取）。
  const shell = container.firstElementChild;
  if (!(shell instanceof HTMLElement) || !shell.hasAttribute('data-long-thread')) {
    return false;
  }

  container.setAttribute(MEASURING_SCOPE_ATTRIBUTE, '');
  void container.scrollHeight;
  return true;
}

/**
 * 守住跳转期间的测量作用域：落定（`scrollend`，带超时兜底）或被用户手势打断后摘掉属性。
 *
 * `movePx` 是本次跳转让 `scrollTop` 移动的量（即落点算式里的 `offsetTop - 22`），用来知道
 * 动画方向。摘掉属性是安全的：`contain-intrinsic-size: auto` 记住的是「已经真实布局过的高度」，
 * 飞行期间布局过的行/代码块不会退回占位高度 —— 这是这个方案成立的关键。
 *
 * 返回幂等的收尾函数。
 */
function watchMeasuringScope(container: HTMLDivElement, movePx: number): () => void {
  const direction = Math.sign(movePx);
  let finished = false;
  let timer = 0;
  let lastScrollTop = container.scrollTop;
  let lastScrollHeight = container.scrollHeight;

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    window.clearTimeout(timer);
    container.removeEventListener('scrollend', finish);
    container.removeEventListener('scroll', handleScroll);
    container.removeAttribute(MEASURING_SCOPE_ATTRIBUTE);
  };

  /**
   * 飞行期间只判断一件事：动画是不是被真实手势打断了。
   * 复用本仓库已有的手势归因口径（`useTranscriptFollowLatest.updateScrollState`：程序自己
   * 指定的方向之外、且内容高度没变的那一步只能来自用户）—— 只是这里的「程序的方向」来自
   * 本次跳转，而不是钉底。
   */
  const handleScroll = () => {
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    if (direction !== 0 && scrollHeight === lastScrollHeight && (scrollTop - lastScrollTop) * direction < 0) {
      finish();
      return;
    }
    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
  };

  // `scrollend` 是首选判据（Chromium 130 支持）；计时器只是兜底，避免作用域留在 DOM 上。
  container.addEventListener('scrollend', finish);
  container.addEventListener('scroll', handleScroll, { passive: true });
  timer = window.setTimeout(finish, MEASURING_SCOPE_TIMEOUT_MS);

  return finish;
}

function MessageNav({
  items,
  scrollContainer,
  disabled,
  earlierHistoryTurns = 0,
  onGrowEarlier,
}: {
  items: UserNavItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  /** 被窗口扣掉、尚不生成标记的轮数（>0 时在导航顶部显示「更早历史」延续标记）。 */
  earlierHistoryTurns?: number;
  /** 「更早历史」标记被点击时的增长动作（保持阅读位置不跳）。 */
  onGrowEarlier?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [previewEventIndex, setPreviewEventIndex] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [navHeight, setNavHeight] = useState(0);
  /**
   * 让组件内的点击跳转能主动作废偏移缓存：跳转会让原本未参与布局的行参与进来。
   * 由下面的 effect 挂上，避免把 effect 依赖搅进 `scrollToMessage`。
   */
  const invalidateNavOffsetsRef = useRef<(() => void) | null>(null);

  /**
   * 进行中的跳转测量作用域的收尾函数（幂等，见 `watchMeasuringScope`）。
   * 卸载时必须收尾：绝不允许把 `data-thread-measuring` 永久留在 DOM 上。
   */
  const measuringScopeRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      const finish = measuringScopeRef.current;
      measuringScopeRef.current = null;
      finish?.();
    },
    [],
  );

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container || items.length === 0 || disabled) {
      setActiveIdx(null);
      return;
    }

    let animationFrame: number | null = null;
    /** 缓存是否过期：布局变化时置脏，重算只发生在下一个帧回调里。 */
    let offsetsStale = true;
    let offsets: NavOffsetEntry[] = [];

    /**
     * 每帧的热路径：先按需做一次测量事务，再做纯比较。
     * 遍历本身在 `pickActiveEventIndex` 内，不碰 DOM、不读布局几何。
     */
    const updateActive = () => {
      animationFrame = null;

      if (offsetsStale) {
        offsetsStale = false;
        offsets = measureNavOffsets(container, items);
      }

      const nextActiveIdx = pickActiveEventIndex(
        offsets,
        container.scrollTop,
        NAV_ACTIVE_ANCHOR_OFFSET_PX,
      );
      setActiveIdx((current) => (current === nextActiveIdx ? current : nextActiveIdx));
    };

    const scheduleUpdateActive = () => {
      if (animationFrame !== null) {
        return;
      }

      animationFrame = window.requestAnimationFrame(updateActive);
    };

    /** 失效入口：只置脏并排一帧，测量本身推迟到帧回调里。 */
    const markOffsetsStale = () => {
      offsetsStale = true;
      scheduleUpdateActive();
    };

    invalidateNavOffsetsRef.current = markOffsetsStale;

    // 布局变化的来源：容器尺寸、滚动内容高度（含离屏行占位高度被真实高度替换）、
    // 窗口尺寸。滚动本身不触发任何一次测量。
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(markOffsetsStale) : null;
    resizeObserver?.observe(container);
    const content = container.firstElementChild;
    if (content) {
      resizeObserver?.observe(content);
    }
    window.addEventListener('resize', markOffsetsStale);

    updateActive();
    container.addEventListener('scroll', scheduleUpdateActive, { passive: true });
    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (invalidateNavOffsetsRef.current === markOffsetsStale) {
        invalidateNavOffsetsRef.current = null;
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', markOffsetsStale);
      container.removeEventListener('scroll', scheduleUpdateActive);
    };
  }, [disabled, items, scrollContainer]);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) {
      setNavHeight(0);
      return;
    }

    const updateNavHeight = () => {
      setNavHeight(container.clientHeight);
    };

    updateNavHeight();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateNavHeight) : null;

    resizeObserver?.observe(container);
    window.addEventListener('resize', updateNavHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateNavHeight);
    };
  }, [scrollContainer]);

  const navMetrics = useMemo(() => {
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const count = items.length;
    const markerHeight = 2;
    const maxMarkerGap = 8;
    const availableHeight = Math.max(navHeight, 48);
    const stackHeight = clamp(availableHeight - 120, 48, availableHeight);
    const spacing = count <= 1 ? maxMarkerGap : Math.min(maxMarkerGap, stackHeight / (count - 1));

    return {
      markerHeight: clamp(markerHeight, 2, 2),
      spacing,
      center: availableHeight / 2,
    };
  }, [items.length, navHeight]);

  const previewItemIndex = previewEventIndex == null
    ? null
    : items.findIndex((item) => item.eventIndex === previewEventIndex);
  const positionedItems = useMemo(
    () =>
      items.map((item, index) => ({
        ...item,
        top:
          items.length <= 1
            ? navMetrics.center
            : navMetrics.center + (index - (items.length - 1) / 2) * navMetrics.spacing,
      })),
    [navMetrics.spacing, navMetrics.center, items],
  );

  // 有被隐藏的历史时即使已挂载标记数少于常规密度，导航也保持可见（显示「更早历史」延续标记）。
  if (items.length <= 1 && !(earlierHistoryTurns > 0)) {
    return null;
  }

  const scrollToMessage = (eventIndex: number) => {
    const element = document.getElementById(`msg-${eventIndex}`);
    const container = scrollContainer.current;
    if (!element || !container) {
      return;
    }

    setActiveIdx(eventIndex);
    // 跳转途中原本未参与布局的行会参与进来：标记缓存过期，让下一帧重算一次偏移。
    invalidateNavOffsetsRef.current?.();
    // 连点两次时先收掉上一次的作用域，避免两个收尾函数互相摘属性。
    measuringScopeRef.current?.();

    // 先进入测量作用域并结算一次布局，落点算式才是在稳定坐标系里算的。
    const measuring = openMeasuringScope(container);
    const offsetTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // 落点算式与 behavior: 'smooth' 保持原样 —— 另一条工作流在用真实引擎探针测量它们。
    container.scrollTo({
      top: container.scrollTop + offsetTop - 22,
      behavior: 'smooth',
    });
    // 飞行期间保持作用域（否则中途又会塌缩），落定或被手势打断后由收尾函数摘掉。
    if (measuring) {
      const finish = watchMeasuringScope(container, offsetTop - 22);
      measuringScopeRef.current = () => {
        finish();
        measuringScopeRef.current = null;
      };
    } else {
      measuringScopeRef.current = null;
    }
  };

  return (
    <div
      data-testid="message-nav"
      className="pointer-events-none absolute left-3 top-0 bottom-0 z-10 flex w-12 items-stretch justify-start"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPreviewEventIndex(null);
      }}
    >
      <div
        className={cn(
          'pointer-events-auto relative h-full w-full transition-opacity duration-normal',
          hovered ? 'opacity-100' : 'opacity-70',
        )}
      >
        {earlierHistoryTurns > 0 ? (
          <button
            type="button"
            data-testid="thread-earlier-history"
            aria-label={`展开更早的历史（还有 ${earlierHistoryTurns} 轮）`}
            title={`更早的历史（还有 ${earlierHistoryTurns} 轮）`}
            onClick={onGrowEarlier}
            className="pointer-events-auto absolute left-0 top-3 flex h-5 w-12 items-center justify-start rounded-md border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="block h-px w-full border-t border-dashed border-muted-foreground/60" />
          </button>
        ) : null}
        {positionedItems.map((item, itemIndex) => (
          <div
            key={item.eventIndex}
            className="absolute left-0 -translate-y-1/2"
            style={{ top: `${item.top}px` }}
          >
            <button
              type="button"
              aria-label={`跳转到消息 ${item.title}`}
              onFocus={() => setPreviewEventIndex(item.eventIndex)}
              onBlur={() => setPreviewEventIndex(null)}
              onMouseEnter={() => setPreviewEventIndex(item.eventIndex)}
              onMouseLeave={() => setPreviewEventIndex(null)}
              onClick={() => scrollToMessage(item.eventIndex)}
              className={cn(
                'flex h-4 w-12 items-center justify-start rounded-md border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              <span
                className={cn(
                  'block origin-left rounded-full transition-[width,background-color,opacity] duration-normal ease-motion-out',
                  previewEventIndex === item.eventIndex
                    ? 'bg-foreground/90'
                    : item.eventIndex === activeIdx
                      ? 'bg-foreground/72'
                      : 'bg-muted-foreground/52',
                )}
                style={{
                  width: getMessageNavMarkerWidth(itemIndex, previewItemIndex, item.eventIndex === activeIdx),
                  height: `${navMetrics.markerHeight}px`,
                }}
              />
            </button>
            {previewEventIndex === item.eventIndex ? (
              <div className="pointer-events-none absolute left-full top-1/2 ml-3 w-80 max-w-[calc(100vw-6rem)] -translate-y-1/2 overflow-hidden rounded-[10px] border border-border/45 bg-[hsl(var(--popover))]/94 px-3 py-2.5 text-popover-foreground shadow-[0_18px_46px_-26px_hsl(var(--surface-shadow-strong)/0.58),0_0_0_1px_hsl(var(--background)/0.45)] backdrop-blur-md animate-in fade-in fill-mode-forwards duration-normal ease-motion-out">
                <div className="block w-full min-w-0 truncate whitespace-nowrap text-xs font-semibold leading-5 text-foreground">
                  {item.title}
                </div>
                {item.summary ? (
                  <div className="mt-0.5 line-clamp-3 text-xs leading-5 text-muted-foreground/86">
                    {item.summary}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 一行助手消息**渲染输出所依赖的全部值**，压成可以直接比较的形式。
 *
 * **为什么需要**：`CodeMuxThreadRenderContext` 的值依赖 `activityRuns` / `toolDurations` /
 * `subagentRunActivity` 这几张每次事件追加都换身份的查找表，所以每来一个事件，**所有已挂载的历史行
 * 都会被重新协调**（`memo` 挡不住 context 变化，而 context 又不能不更新）。叶子层的 `memo` 只能省掉
 * 叶子自身的渲染，省不掉"每行都跑一遍、重算派生值"这件事——实测：全量挂载 24 行时追加一个事件会
 * 产生 **41** 次行渲染，挂载 120 行时是 **201** 次（叶子层那时已经是 1 次）。
 *
 * **单一真源**：行体的每个决定都从 `bindings` 读，比较器也只比较 `bindings`。这样"比较什么"与
 * "渲染什么"不会各自漂移——漂移的后果是 UI 静默不更新，比多渲染几次严重得多。完备性由
 * `CodeMuxThread.rowRenderCounts.test.tsx` 里"逐字段翻转"的用例守住。
 *
 * **按身份比较的字段**（`args` / `result` / `status` / `data` / 卡片活动对象）：与叶子层 `memo`
 * 依赖的前提完全一致——UI 现在能正确更新，就说明这些对象是被**替换**而不是被就地改写的。
 * 卡片活动对象例外地按身份比较是有意的：卡片内容复杂、逐字段比较得不偿失，而这样的行每个委派段
 * 最多一行。
 */
type TextPartState = Extract<PartState, { type: 'text' }>;
type ReasoningPartState = Extract<PartState, { type: 'reasoning' }>;
type ToolCallPartState = Extract<PartState, { type: 'tool-call' }>;
type DataPartState = Extract<PartState, { type: 'data' }>;

/** 一个 part 交给叶子的关键值。渲染与比较共用它，字段与叶子 props 一一对应。 */
type RowPartKey =
  | { kind: 'text'; text: TextPartState['text'] }
  | { kind: 'reasoning'; text: ReasoningPartState['text']; streaming: boolean }
  | {
    kind: 'tool-call';
    toolName: ToolCallPartState['toolName'];
    toolCallId: ToolCallPartState['toolCallId'];
    args: ToolCallPartState['args'];
    argsText: ToolCallPartState['argsText'];
    result: ToolCallPartState['result'];
    isError: ToolCallPartState['isError'];
    status: ToolCallPartState['status'];
  }
  | { kind: 'data'; name: DataPartState['name']; data: DataPartState['data'] }
  | { kind: 'other' };

type RowPartBinding = {
  key: RowPartKey;
  /** 委派卡片只画过程步骤（思考 / 普通工具）；这个布尔预先算好，卡片侧不再读 part 本身。 */
  activityRunPart: boolean;
};

export type AssistantRowBindings = {
  /** 整行不渲染的两种原因，或者正常渲染。比较器只需要知道这个结论。 */
  render: 'empty' | 'hidden' | 'content';
  compactToggle: boolean;
  /** 折叠开关按钮上真正画出来的字段。 */
  collapse: {
    turnKey: string;
    durationMs: AssistantCollapseInfo['durationMs'];
    stepCount: AssistantCollapseInfo['stepCount'];
    hasError: AssistantCollapseInfo['hasError'];
  } | undefined;
  collapseExpanded: boolean;
  hideCollapsedContent: boolean;
  hideCollapsedReasoning: boolean;
  runKey: string | undefined;
  runLive: boolean;
  runHead: boolean;
  runOpen: boolean;
  hasDelegation: boolean;
  delegationRunning: boolean;
  delegationNodeCount: number;
  delegationCardVisible: boolean;
  /** 卡片主体（只有"本行是委派段首行且有子智能体"时才非空）。按身份比较，见文件头注释。 */
  delegationCardActivity: SubagentActivity | undefined;
  partsVisible: boolean;
  footerVisible: boolean;
  shouldRenderFooter: boolean;
  footerDurationMs: number | undefined;
  sourceRole: 'system' | 'assistant';
  sourceUuid: string | undefined;
  sourceProviderTurnId: string | undefined;
  sourceProviderTurnOrdinal: number | undefined;
  isFinal: boolean;
  sourceTimestamp: number | undefined;
  isForkable: boolean;
  isLastRow: boolean;
  bottomSpacing: string;
  /** 仅当本行确实有 `data` part 时才是真实值：`getMessageText` 与正文长度同阶，不能无条件算。 */
  dataMessageText: string;
  parsePlan: boolean;
  /** 本行用到的工具耗时（内容指纹），渲染时查的是同一个来源，见 `usedDurations`。 */
  usedDurationsKey: string;
  /** 本行用到的工具耗时（由派生一并给出，渲染叶子时按 `toolCallId` 查它；等价性由上方 key 表达）。 */
  usedDurations: Record<string, number>;
  parts: readonly RowPartBinding[];
};

type AssistantRowProps = {
  sessionId: string;
  bindings: AssistantRowBindings;
  onToggleExpandedTurn: (turnKey: string) => void;
  onToggleRun: (runKey: string, currentlyOpen: boolean) => void;
};

type DeriveAssistantRowInput = {
  message: MessageState;
  isLastMessage: boolean;
  compactAiOutput: boolean;
  isRunning: boolean;
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>;
  expandedTurnKeys: Set<string>;
  expandedRunKeys: Set<string>;
  claimedRunKeys: Set<string>;
  activityRuns: ActivityRuns;
  subagentRunActivity: Map<string, SubagentActivity>;
  toolDurations: Record<string, number>;
  turnByEventIndex: Map<number, ConversationTurn<AgentMessage>>;
  turnOrdinalById: Map<string, number>;
  pendingTurnId?: string;
};

/** 本行用到的工具耗时：只装本行 part 引用的那些 id，避免把整张表带进比较。 */
function collectUsedDurations(
  content: readonly PartState[],
  toolDurations: Record<string, number>,
): Record<string, number> {
  const used: Record<string, number> = {};
  for (const part of content) {
    if (part.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue;
    const duration = toolDurations[part.toolCallId];
    if (duration !== undefined) used[part.toolCallId] = duration;
  }
  return used;
}

function usedDurationsKey(used: Record<string, number>): string {
  return Object.keys(used).sort().map((id) => `${id}:${used[id]}`).join('|');
}

function deriveAssistantRowBindings(input: DeriveAssistantRowInput): AssistantRowBindings {
  const { message, isRunning } = input;
  const collapseInfo = input.compactAiOutput
    ? getMessageCollapseInfo(message, input.collapseInfoByEventIndex)
    : undefined;
  const compactToggle = collapseInfo?.isToggleMessage === true;
  const collapseExpanded = collapseInfo ? input.expandedTurnKeys.has(collapseInfo.turnKey) : false;
  const hideCollapsedContent = Boolean(collapseInfo && !collapseExpanded && !collapseInfo.hideReasoningOnly);
  const hideCollapsedReasoning = Boolean(collapseInfo?.hideReasoningOnly && !collapseExpanded);

  const sourceEventIndex = getSourceEventIndex(message);
  const runPlacement: ActivityRunPlacement | undefined = sourceEventIndex != null
    ? input.activityRuns.placementByEventIndex.get(sourceEventIndex)
    : undefined;
  const run = runPlacement ? input.activityRuns.runByKey.get(runPlacement.runKey) : undefined;
  const activity = run ? input.subagentRunActivity.get(run.runKey) : undefined;
  const delegationRunning = activity != null && activity.summary.running > 0;
  const runOpen = run
    ? (input.claimedRunKeys.has(run.runKey)
      ? input.expandedRunKeys.has(run.runKey)
      : run.live || delegationRunning)
    : true;
  const delegationCardVisible = runPlacement?.isHead === true
    && (collapseInfo == null || collapseExpanded)
    && activity != null
    && activity.nodes.length > 0;
  const partsVisible = !hideCollapsedContent
    && (activity == null || delegationCardVisible || runOpen);

  const sourceRole = message.metadata.custom?.sourceRole === 'system' ? 'system' : 'assistant';
  const turn = getSourceEventIndices(message)
    .map((eventIndex) => input.turnByEventIndex.get(eventIndex))
    .find((candidate) => candidate?.footerAnchorEventIndex != null);
  const isFinal = message.metadata.custom?.isFinalAssistantMessage === true;
  const shouldRenderFooter = shouldRenderAssistantFooter({
    role: sourceRole,
    isFinalAssistantMessage: isFinal,
    turnStatus: turn?.status,
    turnId: turn?.id,
    pendingTurnId: input.pendingTurnId,
  });
  const footerVisible = !hideCollapsedContent && shouldRenderFooter;
  const isLastRow = input.isLastMessage && !isRunning;
  const sourceUuid = message.metadata.custom?.sourceUuid as string | undefined;

  let dataMessageText = '';
  // `MessageState['content']` 是"用户/助手 part 的联合"，而这里只关心助手侧的 part 形态：
  // 与 `MessagePrimitive.GroupedParts` 渲染时用的是同一批对象，所以按助手侧类型读取是安全的。
  const content = message.content as readonly PartState[];
  const parts: RowPartBinding[] = [];
  for (const part of content) {
    parts.push({
      key: toRowPartKey(part),
      activityRunPart: isActivityRunPart(part)
        && !(part.type === 'tool-call' && isSubagentToolName(part.toolName)),
    });
    if (part.type === 'data' && dataMessageText === '') {
      dataMessageText = getMessageText(message);
    }
  }
  const used = collectUsedDurations(content, input.toolDurations);

  return {
    render: message.content.length === 0 && !compactToggle
      ? 'empty'
      : (compactToggle || delegationCardVisible || partsVisible || footerVisible ? 'content' : 'hidden'),
    compactToggle,
    collapse: collapseInfo
      ? {
        turnKey: collapseInfo.turnKey,
        durationMs: collapseInfo.durationMs,
        stepCount: collapseInfo.stepCount,
        hasError: collapseInfo.hasError,
      }
      : undefined,
    collapseExpanded,
    hideCollapsedContent,
    hideCollapsedReasoning,
    runKey: run?.runKey,
    runLive: run?.live === true,
    runHead: runPlacement?.isHead === true,
    runOpen,
    hasDelegation: activity != null,
    delegationRunning,
    delegationNodeCount: activity?.nodes.length ?? 0,
    delegationCardVisible,
    delegationCardActivity: delegationCardVisible ? activity : undefined,
    partsVisible,
    footerVisible,
    shouldRenderFooter,
    footerDurationMs: turn ? buildFooterStatsFromTurn(turn)?.durationMs : undefined,
    sourceRole,
    sourceUuid,
    sourceProviderTurnId: message.metadata.custom?.sourceProviderTurnId as string | undefined,
    sourceProviderTurnOrdinal: turn ? input.turnOrdinalById.get(turn.id) : undefined,
    isFinal,
    sourceTimestamp: getSourceTimestamp(message),
    isForkable: shouldRenderFooter && !isRunning && sourceUuid != null,
    isLastRow,
    bottomSpacing: assistantMessageBottomSpacing({
      isLastRow,
      isToggleMessage: compactToggle,
      shouldRenderFooter,
    }),
    dataMessageText,
    parsePlan: isFinal && turn?.status === 'completed',
    usedDurationsKey: usedDurationsKey(used),
    usedDurations: used,
    parts,
  };
}

function toRowPartKey(part: PartState): RowPartKey {
  switch (part.type) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'reasoning':
      return { kind: 'reasoning', text: part.text, streaming: part.status?.type === 'running' };
    case 'tool-call':
      return {
        kind: 'tool-call',
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        args: part.args,
        argsText: part.argsText,
        result: part.result,
        isError: part.isError,
        status: part.status,
      };
    case 'data':
      return { kind: 'data', name: part.name, data: part.data };
    default:
      return { kind: 'other' };
  }
}

/**
 * `AssistantLikeMessage` 的 props 比较器。
 *
 * 只比两样：几个跨行稳定的 props，以及 `bindings` 的每个字段。**不要**比 `message` 的身份——
 * assistant-ui 每次线程更新都可能重建 `MessageState`，比身份会让这条优化彻底失效；而"渲染输出
 * 依赖什么"已经由 `bindings` 完整表达（行体只从 `bindings` 取值）。`usedDurations` 也不比身份：
 * 它的内容等价性由 `bindings.usedDurationsKey` 表达。
 */
function areAssistantRowPropsEqual(prev: AssistantRowProps, next: AssistantRowProps): boolean {
  return prev.sessionId === next.sessionId
    && prev.onToggleExpandedTurn === next.onToggleExpandedTurn
    && prev.onToggleRun === next.onToggleRun
    && assistantRowBindingsEqual(prev.bindings, next.bindings);
}

/** 逐字段比较。任何一个字段漏比，都会变成"UI 静默不更新"，所以由用例逐字段翻转守住。 */
export function assistantRowBindingsEqual(
  a: AssistantRowBindings,
  b: AssistantRowBindings,
): boolean {
  if (a === b) return true;
  if (a.render !== b.render
    || a.compactToggle !== b.compactToggle
    || a.collapseExpanded !== b.collapseExpanded
    || a.hideCollapsedContent !== b.hideCollapsedContent
    || a.hideCollapsedReasoning !== b.hideCollapsedReasoning
    || a.runKey !== b.runKey
    || a.runLive !== b.runLive
    || a.runHead !== b.runHead
    || a.runOpen !== b.runOpen
    || a.hasDelegation !== b.hasDelegation
    || a.delegationRunning !== b.delegationRunning
    || a.delegationNodeCount !== b.delegationNodeCount
    || a.delegationCardVisible !== b.delegationCardVisible
    || a.delegationCardActivity !== b.delegationCardActivity
    || a.partsVisible !== b.partsVisible
    || a.footerVisible !== b.footerVisible
    || a.shouldRenderFooter !== b.shouldRenderFooter
    || a.footerDurationMs !== b.footerDurationMs
    || a.sourceRole !== b.sourceRole
    || a.sourceUuid !== b.sourceUuid
    || a.sourceProviderTurnId !== b.sourceProviderTurnId
    || a.sourceProviderTurnOrdinal !== b.sourceProviderTurnOrdinal
    || a.isFinal !== b.isFinal
    || a.sourceTimestamp !== b.sourceTimestamp
    || a.isForkable !== b.isForkable
    || a.isLastRow !== b.isLastRow
    || a.bottomSpacing !== b.bottomSpacing
    || a.dataMessageText !== b.dataMessageText
    || a.parsePlan !== b.parsePlan
    || a.usedDurationsKey !== b.usedDurationsKey) {
    return false;
  }

  const collapseA = a.collapse;
  const collapseB = b.collapse;
  if (collapseA !== collapseB) {
    if (!collapseA || !collapseB
      || collapseA.turnKey !== collapseB.turnKey
      || collapseA.durationMs !== collapseB.durationMs
      || collapseA.stepCount !== collapseB.stepCount
      || collapseA.hasError !== collapseB.hasError) {
      return false;
    }
  }

  if (a.parts.length !== b.parts.length) return false;
  for (let index = 0; index < a.parts.length; index += 1) {
    if (!rowPartBindingEqual(a.parts[index], b.parts[index])) return false;
  }
  return true;
}

function rowPartBindingEqual(a: RowPartBinding, b: RowPartBinding): boolean {
  if (a === b) return true;
  if (a.activityRunPart !== b.activityRunPart) return false;

  const keyA = a.key;
  const keyB = b.key;
  if (keyA.kind !== keyB.kind) return false;
  switch (keyA.kind) {
    case 'text':
      return keyA.text === (keyB as typeof keyA).text;
    case 'reasoning': {
      const other = keyB as typeof keyA;
      return keyA.text === other.text && keyA.streaming === other.streaming;
    }
    case 'tool-call': {
      const other = keyB as typeof keyA;
      return keyA.toolName === other.toolName
        && keyA.toolCallId === other.toolCallId
        && keyA.args === other.args
        && keyA.argsText === other.argsText
        && keyA.result === other.result
        && keyA.isError === other.isError
        && keyA.status === other.status;
    }
    case 'data': {
      const other = keyB as typeof keyA;
      return keyA.name === other.name && keyA.data === other.data;
    }
    default:
      return true;
  }
}

/**
 * 一行助手消息。
 *
 * 它被 `memo` 包住，比较器只认 `bindings`（见 `areAssistantRowPropsEqual` 与文件头那段注释）。
 * 行体**不再直接读** `activityRuns` / `subagentRunActivity` / `toolDurations` 这几张每次都换身份的
 * 查找表——它们只出现在 `deriveAssistantRowBindings` 里，这样"比较什么"与"渲染什么"是同一份真源。
 * `message` 只在委派卡片里取 part 对象用于渲染，其取值等价性由 `bindings.parts` 逐项表达。
 */
const AssistantLikeMessage = memo(function AssistantLikeMessage({
  message,
  sessionId,
  bindings,
  onToggleExpandedTurn,
  onToggleRun,
}: AssistantRowProps & { message: MessageState }) {
  const openSubagentInSidePanel = useSubagentStore((state) => state.openInSidePanel);
  const forkSession = useSessionStore((state) => state.forkSession);
  const [isForking, setIsForking] = useState(false);

  if (bindings.render !== 'content') {
    return null;
  }

  const delegateCardActivity = bindings.delegationCardActivity;

  const handleFork = async () => {
    if (!bindings.isForkable || !bindings.sourceUuid || isForking) return;
    setIsForking(true);
    try {
      await forkSession(
        sessionId,
        bindings.sourceUuid,
        bindings.sourceUuid,
        bindings.sourceProviderTurnId,
        bindings.sourceProviderTurnOrdinal,
      );
    } catch {
      // The session store retains the error for the surrounding session UI.
    } finally {
      setIsForking(false);
    }
  };

  /**
   * 段内单个过程步骤（思考 / 工具）的渲染。委派卡片主体与平铺列表共用这一个开关。
   * 视觉决定一律从 `bindings` 取；part 自身只提供"这一部分是什么内容"。
   */
  const renderLeafPart = (part: PartState): ReactNode => {
    switch (part.type) {
      case 'text':
        return (
          <CodeMuxTextMessagePart
            text={part.text}
            parsePlan={bindings.parsePlan}
          />
        );
      case 'reasoning':
        if (bindings.hideCollapsedReasoning) {
          return null;
        }
        return (
          <ActivityStepThinking
            text={part.text}
            streaming={part.status?.type === 'running'}
          />
        );
      case 'tool-call':
        return (
          <CodeMuxToolCallMessagePart
            toolName={part.toolName}
            toolCallId={part.toolCallId}
            sessionId={sessionId}
            args={part.args}
            argsText={part.argsText}
            result={part.result}
            isError={part.isError}
            status={part.status}
            durationMs={typeof part.toolCallId === 'string' ? bindings.usedDurations[part.toolCallId] : undefined}
          />
        );
      case 'data':
        return (
          <CodeMuxDataMessagePart
            name={part.name}
            data={part.data}
            sessionId={sessionId}
            messageText={bindings.dataMessageText}
          />
        );
      default:
        return null;
    }
  };

  return (
    <MessagePrimitive.Root
      data-message-row
      className={cn('group/message-row flex w-full justify-start', bindings.bottomSpacing)}
    >
      <div
        className={cn(
          'w-full min-w-0 space-y-1 text-ui-body leading-relaxed',
          bindings.sourceRole === 'system' && 'text-muted-foreground',
        )}
      >
        {bindings.compactToggle && bindings.collapse ? (
          <AssistantCollapseToggle
            expanded={bindings.collapseExpanded}
            durationMs={bindings.collapse.durationMs}
            stepCount={bindings.collapse.stepCount}
            hasError={bindings.collapse.hasError}
            onClick={() => onToggleExpandedTurn(bindings.collapse!.turnKey)}
          />
        ) : null}
        {bindings.delegationCardVisible && delegateCardActivity && bindings.runKey ? (
          <SubagentActivityCard
            activity={delegateCardActivity}
            live={bindings.runLive || delegateCardActivity.summary.running > 0}
            open={bindings.runOpen}
            onToggle={() => onToggleRun(bindings.runKey!, bindings.runOpen)}
            onOpenSubagent={(subagentId) => openSubagentInSidePanel(sessionId, subagentId)}
          >
            {message.content.map((part, index) => (
              isActivityRunPart(part)
                && !(part.type === 'tool-call' && isSubagentToolName(part.toolName)) ? (
                <Fragment key={`subagent-step-${index}`}>{renderLeafPart(part as PartState)}</Fragment>
              ) : null
            ))}
          </SubagentActivityCard>
        ) : null}
        {bindings.partsVisible ? (
          <MessagePrimitive.GroupedParts groupBy={GROUP_BY_PART} indicator="never">
            {({ part, children }) => {
              switch (part.type) {
                case 'group-activity-run':
                  // 分组头已移除：组节点只作为稳定边界，步骤按源码顺序直接透传（平铺）。
                  // 委派卡片所在行是例外：卡片已画出过程步骤，这里只透传正文等非过程部分。
                  if (bindings.delegationCardVisible) {
                    return null;
                  }
                  return children;
                case 'text':
                case 'reasoning':
                case 'tool-call':
                case 'data':
                  // 委派卡片所在行：卡片已画出过程步骤（思考 + 普通工具），
                  // 这里只补卡片外的部分（正文 / 数据 / 问询卡片）。
                  if (bindings.delegationCardVisible && isActivityRunPart(part)) {
                    return null;
                  }
                  return renderLeafPart(part);
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        ) : null}
        {bindings.footerVisible ? (
          <MessageFooter
            timestamp={bindings.sourceTimestamp}
            stats={bindings.footerDurationMs === undefined ? undefined : { durationMs: bindings.footerDurationMs }}
            revealOnHover
            sessionId={sessionId}
            sourceUuid={bindings.sourceUuid}
            canFork={bindings.isForkable}
            isForking={isForking}
            onFork={handleFork}
          />
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}, areAssistantRowPropsEqual);

/**
 * 流式页脚的"正在执行"状态行。
 *
 * 单独抽成 `memo` 组件，是为了让它彻底脱离分帧绘制的重渲染路径：
 * `StreamingContent` 会随绘制节奏反复重渲染，而这一行里的 `DotMatrix`
 * 是**绘制类**动画（SVG `opacity` 闪烁），无法卸载到合成线程。让它跟着每帧
 * 重渲染既无意义，也会把主线程预算浪费在重算这一小段 DOM 上。
 * 它的 props 只有稳定的 `sessionId` / `startTime`，高频 TPS 由内部子组件单独刷新。
 */
const StreamingTokenSpeedIndicator = memo(function StreamingTokenSpeedIndicator({
  sessionId,
  turnStartedAt,
}: {
  sessionId: string;
  turnStartedAt?: number;
}) {
  const speed = useTokenOutputSpeed(sessionId, turnStartedAt, true);
  if (speed == null) return null;
  return (
    <TooltipHint content="估算输出速度（正文 + 思考）">
      <span
        className="inline-flex items-center gap-1 text-ui-body leading-none tabular-nums text-muted-foreground"
        aria-label={`估算输出速度（正文 + 思考）：${speed.toFixed(1)} token 每秒`}
        tabIndex={0}
      >
        <span aria-hidden>·</span>
        <Gauge className="size-[1em]" aria-hidden="true" />
        {speed.toFixed(1)} tok/s
      </span>
    </TooltipHint>
  );
});

const StreamingStatusFooter = memo(function StreamingStatusFooter({
  sessionId,
  startTime,
}: {
  sessionId: string;
  startTime?: number;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 py-1 text-ui-body text-muted-foreground animate-in fade-in fill-mode-forwards duration-slow ease-motion-out',
      )}
    >
      <DotMatrix state="loading" className="size-4" label="正在执行" />
      <RunningElapsedTimer startTime={startTime} label="正在执行" />
      <StreamingTokenSpeedIndicator
        key={`${sessionId}:${startTime ?? 'initial'}`}
        sessionId={sessionId}
        turnStartedAt={startTime}
      />
    </div>
  );
});

function StreamingContent({
  sessionId,
  events,
}: {
  sessionId: string;
  events: AgentMessage[];
}) {
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const queryStartTime = useAgentStore((state) => state.queryStartTime[sessionId]);
  const thinking = useAgentStore((state) => state.streamingThinking[sessionId] ?? '');
  const text = useAgentStore((state) => state.streamingText[sessionId] ?? '');
  const thinkingEpoch = useAgentStore((state) => state.streamingThinkingStartEventCount[sessionId] ?? 0);
  const lastAssistantText = useMemo(() => getLastAssistantText(events), [events]);
  const lastAssistantThinking = useMemo(() => getLastAssistantThinking(events), [events]);
  const lastCommittedThinkingIndex = useMemo(() => getLastCommittedThinkingEventIndex(events), [events]);
  const duplicateLiveText = Boolean(
    text
    && lastAssistantText
    && (
      text === lastAssistantText
      || text.startsWith(lastAssistantText)
      || lastAssistantText.startsWith(text)
    ),
  );
  // If text is actually a mis-routed thinking stream, keep it out of the markdown area.
  const textIsMisroutedThinking = Boolean(
    text
    && (
      (thinking && (thinking.startsWith(text) || text.startsWith(thinking) || thinking.includes(text)))
      || (lastAssistantThinking && (
        lastAssistantThinking === text
        || lastAssistantThinking.startsWith(text)
        || text.startsWith(lastAssistantThinking)
      ))
    ),
  );
  // OpenCode 一回合会产出多段"思考→正文"。实时思考流开始于最近一次 thinking
  // 提交之后 → 是下一段落的新思考，必须显示；流开始后时间线里又提交了
  // thinking → 缓冲区只是已提交内容的残留副本，让位给时间线气泡。
  const liveThinkingIsStaleCopy = lastCommittedThinkingIndex >= thinkingEpoch;
  // Prefer reasoning panel: never show live thinking content as answer markdown.
  const visibleThinking = liveThinkingIsStaleCopy
    ? ''
    : (thinking || (textIsMisroutedThinking ? text : ''));
  const visibleText = (
    duplicateLiveText
    || textIsMisroutedThinking
  ) ? '' : text;

  // 分帧绘制：到达只决定目标，真正画多少由 backlog 推导，使批次大小在一个回合内
  // 相差一个数量级时也不会表现为"一跳一跳"。可见性判定仍用全文，只有渲染切片被
  // 节流 —— 所以"有没有内容"的判断不受影响，不会有延迟出现的空档。
  const revealActive = isRunning && !stopped;
  const revealedText = useStreamingTextReveal(visibleText, revealActive);
  const revealedThinking = useStreamingTextReveal(visibleThinking, revealActive);

  /**
   * 增量分块：只重解析尾部那一块，避免每次提交都对累积全文重新分块。
   * 实测（研究文档 5.14 节）流式提交耗时 694ms → 564ms（−19%）、单次最长 14.1ms → 12.3ms，
   * 且两轮共 786 次提交的分块结果与上游参考实现逐项一致。
   *
   * 每实例一份（它是有状态缓存）。`StreamingContent` 是常驻的（这里的 `return null` 不卸载组件），
   * 所以实例会跨回合、跨会话继续带缓存：只有当新文本仍以上一次的冻结前缀开头时才复用，否则整体
   * 重解析（前缀对不上只是白丢收益，结果仍与参考实现一致）。而上游唯一那条"要看全文才决定"的规则
   * （出现 `[^` 就把全文当成一块）已由 `createIncrementalBlockParser` 保守退让掉，见该文件头注释第 1 条。
   */
  const blockParser = useMemo(() => createIncrementalBlockParser(parseMarkdownIntoBlocks), []);

  if (stopped || (!isRunning && !thinking && !visibleText)) {
    return null;
  }

  const isThinking = visibleThinking.length > 0;

  const liveThinkingStep = (
    <ActivityStepThinking
      text={visibleThinking}
      streaming={isRunning}
      body={
        <pre className="whitespace-pre-wrap font-sans text-ui-body leading-relaxed text-muted-foreground">
          {revealedThinking}
        </pre>
      }
    />
  );

  return (
    <div className="mb-2 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-1 text-ui-body leading-relaxed">
        {isThinking ? (
          <div data-streaming-reasoning="true" className="w-full min-w-0">
            {liveThinkingStep}
          </div>
        ) : null}

        {visibleText ? (
          <div
            data-streaming-text="markdown"
            className="relative text-ui-body leading-relaxed text-foreground"
          >
            <Streamdown
              {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}
              parseMarkdownIntoBlocksFn={blockParser}
            >
              {revealedText}
            </Streamdown>
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
          </div>
        ) : null}

        {isRunning ? <StreamingStatusFooter sessionId={sessionId} startTime={queryStartTime} /> : null}
      </div>
    </div>
  );
}

function getLastAssistantText(events: AgentMessage[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'assistant') {
      continue;
    }

    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } =>
        block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) {
      return text;
    }
  }

  return '';
}

function getLastAssistantThinking(events: AgentMessage[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'assistant') {
      continue;
    }

    const thinking = event.data.message.content
      .filter((block): block is { type: 'thinking'; thinking: string } =>
        block?.type === 'thinking' && typeof block.thinking === 'string',
      )
      .map((block) => block.thinking)
      .join('')
      .trim();
    if (thinking) {
      return thinking;
    }
  }

  return '';
}

/** 最新一条带非空 thinking 的 assistant 事件下标（没有则 -1）。 */
function getLastCommittedThinkingEventIndex(events: AgentMessage[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'assistant') {
      continue;
    }
    const hasThinking = event.data.message.content.some((block) => (
      isRecord(block)
      && block.type === 'thinking'
      && typeof block.thinking === 'string'
      && block.thinking.length > 0
    ));
    if (hasThinking) {
      return index;
    }
  }
  return -1;
}

function getMessageText(message: MessageState) {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function getMessageCollapseInfo(
  message: MessageState,
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>,
): AssistantCollapseInfo | undefined {
  return getCollapseInfoForSourceIndices(
    getSourceEventIndices(message),
    collapseInfoByEventIndex,
    {
      hasReasoning: message.content.some((part) => part.type === 'reasoning'),
      isSplitHead: message.metadata.custom?.isSplitHead === false ? false : undefined,
    },
  );
}

function getSourceEventIndices(message: MessageState): number[] {
  const value = message.metadata.custom?.sourceEventIndices;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is number => typeof entry === 'number');
  }

  const sourceEventIndex = getSourceEventIndex(message);
  return sourceEventIndex != null ? [sourceEventIndex] : [];
}

function getSourceEventIndex(message: MessageState): number | undefined {
  const value = message.metadata.custom?.sourceEventIndex;
  return typeof value === 'number' ? value : undefined;
}

function getSourceTimestamp(message: MessageState): number | undefined {
  const value = message.metadata.custom?.sourceTimestamp;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

export function incrementToolDurationMap(
  prevDurations: Record<string, number>,
  events: AgentMessage[],
  fromIndex: number,
): Record<string, number> {
  let changed = false;
  let durations = prevDurations;

  // Only process new events for tool_progress and task_notification
  for (let index = fromIndex; index < events.length; index++) {
    const event = events[index];

    if (event.kind === 'raw' && event.data.type === 'tool_progress') {
      const toolUseId = event.data.tool_use_id;
      const elapsed = event.data.elapsed_time_seconds;
      if (typeof toolUseId === 'string' && typeof elapsed === 'number') {
        if (durations[toolUseId] !== Math.round(elapsed * 1000)) {
          if (durations === prevDurations) durations = { ...prevDurations };
          durations[toolUseId] = Math.round(elapsed * 1000);
          changed = true;
        }
      }
    }

    if ((event.kind === 'raw' || event.kind === 'system') && event.data?.type === 'system' && event.data?.subtype === 'task_notification') {
      const data = event.data as Record<string, unknown>;
      const toolUseId = data.tool_use_id;
      const usage = isRecord(data.usage) ? data.usage : undefined;
      const durationMs = usage?.duration_ms;
      if (typeof toolUseId === 'string' && typeof durationMs === 'number' && durationMs > 0) {
        if (durations[toolUseId] !== durationMs) {
          if (durations === prevDurations) durations = { ...prevDurations };
          durations[toolUseId] = durationMs;
          changed = true;
        }
      }
    }
  }

  // Keep the previous reference when nothing changed so downstream memoization
  // (context value / memoized rows) survives unrelated event appends.
  return changed ? durations : prevDurations;
}

export function buildToolDurationMap(events: AgentMessage[]): Record<string, number> {
  const durations: Record<string, number> = {};

  // Only use event-reported durations
  for (const event of events) {
    if (event.kind === 'raw' && event.data.type === 'tool_progress') {
      const toolUseId = event.data.tool_use_id;
      const elapsed = event.data.elapsed_time_seconds;
      if (typeof toolUseId === 'string' && typeof elapsed === 'number') {
        durations[toolUseId] = Math.round(elapsed * 1000);
      }
    }

    if ((event.kind === 'raw' || event.kind === 'system') && event.data?.type === 'system' && event.data?.subtype === 'task_notification') {
      const data = event.data as Record<string, unknown>;
      const toolUseId = data.tool_use_id;
      const usage = isRecord(data.usage) ? data.usage : undefined;
      const durationMs = usage?.duration_ms;
      if (typeof toolUseId === 'string' && typeof durationMs === 'number' && durationMs > 0) {
        durations[toolUseId] = durationMs;
      }
    }
  }

  return durations;
}

function buildFooterStatsFromTurn(
  turn: ConversationTurn<AgentMessage>,
): MessageFooterStats | undefined {
  if (turn.status === 'failed' || turn.status === 'running') {
    return undefined;
  }

  return turn.durationMs !== undefined ? { durationMs: turn.durationMs } : undefined;
}

/**
 * Compatibility projection for callers that still need result stats by event
 * index. The UI itself consumes Turn status and stats directly.
 */
export function buildAssistantResultStatsMap(
  events: AgentMessage[],
): Record<number, MessageFooterStats> {
  const statsMap: Record<number, MessageFooterStats> = {};
  const turns = buildConversationTurns(events, { isRunning: false });

  for (const turn of turns) {
    if (turn.status !== 'completed' || turn.footerAnchorEventIndex == null) {
      continue;
    }

    const stats = buildFooterStatsFromTurn(turn);
    if (!stats) {
      continue;
    }

    statsMap[turn.footerAnchorEventIndex] = {
      ...stats,
    };
  }

  return statsMap;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
