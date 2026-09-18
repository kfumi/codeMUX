import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  unstable_useThreadMessageIds,
  useAui,
  useAuiState,
  type MessageState,
} from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import { ArrowDown, FileText, Layers, Loader2, MessageSquare, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Streamdown } from 'streamdown';

import { MessageFooter, type MessageFooterStats } from '@/components/assistant-ui/message-footer';
import { ToolGroup } from '@/components/assistant-ui/tool-group';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { isAskUserQuestionToolName } from '@/lib/askUserQuestionTools';
import { useSubagentStore } from '@/stores/subagentStore';
import { useStreamingTextReveal } from './useStreamingTextReveal';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { Button } from '@/components/ui/button';
import { DotMatrix } from '@/components/ui/dot-matrix';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipHint, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/reasoning';
import { cn } from '../../../lib/utils';
import {
  AGENT_REWIND_CAPABILITIES,
  isRewindableUserEvent,
  useAgentStore,
  type AgentMessage,
  type RewindMode,
} from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildConversationTurnIndex, buildConversationTurns } from '../../../lib/conversationTurns';
import type { ConversationTurn, ConversationTurnStatus } from '../../../types/conversationTurn';

import { isInterruptMarker } from '../../../stores/agentEventParsing';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  CodeMuxDataMessagePart,
  CodeMuxReasoningMessagePart,
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
const INTERRUPT_LABEL = '用户中断请求';
const MESSAGE_NAV_HIDE_BREAKPOINT = 860;
const THREAD_CONTENT_PADDING_WITH_NAV = 'px-20';
const THREAD_CONTENT_PADDING_WITHOUT_NAV = 'px-5';
/**
 * Above this event count (~60 messages) the transcript is long enough that
 * off-screen rows are worth excluding from layout/paint. See the
 * `[data-long-thread] [data-message-row]` rule in globals.css.
 */
const LONG_THREAD_EVENT_THRESHOLD = 120;
const GROUP_BY_PART_INNER = groupPartByType({
  reasoning: ['group-thinking'],
  'tool-call': ['group-tool-call'],
  'standalone-tool-call': [],
});
const GROUP_BY_PART = (
  part: Parameters<typeof GROUP_BY_PART_INNER>[0],
  context?: Parameters<typeof GROUP_BY_PART_INNER>[1],
) => {
  if (part.type === 'tool-call' && isAskUserQuestionToolName(part.toolName)) {
    return [];
  }
  return GROUP_BY_PART_INNER(part, context);
};
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

/** Bottom margin of an assistant row: the row right above the composer keeps
 * only a small tail — the composer's sticky footer already adds its own
 * breathing room. */
export function assistantMessageBottomSpacing(input: {
  isLastRow: boolean;
  isToggleMessage: boolean;
  shouldRenderFooter: boolean;
}): string {
  if (input.isLastRow) {
    return 'mb-2';
  }
  if (input.isToggleMessage || input.shouldRenderFooter) {
    return 'mb-4';
  }
  return 'mb-5';
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
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Set<string>>(() => new Set());
  const [showMessageNav, setShowMessageNav] = useState(true);

  useEffect(() => {
    setExpandedTurnKeys(new Set());
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
  const userNavItems = useMemo(() => buildUserNavItems(events), [events]);
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
          && prev.hideReasoningOnly === info.hideReasoningOnly;
      })
    ) {
      collapseCacheRef.current = { events, timestamps: eventTimestamps, flags, map: cache.map };
      return cache.map;
    }
    collapseCacheRef.current = { events, timestamps: eventTimestamps, flags, map: finalMap };
    return finalMap;
  }, [events, eventTimestamps, isRunning, stopped, subagentFlowPending]);

  const threadRenderContextValue = useMemo(() => ({
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    onToggleExpandedTurn: toggleExpandedTurn,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
  }), [
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    toggleExpandedTurn,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
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
                'mx-auto flex w-full flex-1 flex-col pt-5',
                showMessageNav ? THREAD_CONTENT_PADDING_WITH_NAV : THREAD_CONTENT_PADDING_WITHOUT_NAV,
              )}
              style={{ maxWidth: 'var(--content-width, 52rem)' }}
            >
              <CodeMuxThreadRenderContext.Provider value={threadRenderContextValue}>
                <CodeMuxThreadMessages />
              </CodeMuxThreadRenderContext.Provider>
              {stopped ? <InterruptBanner /> : null}
              <StreamingContent sessionId={sessionId} events={events} />
              <SubagentRunningRow sessionId={sessionId} />
              <ThreadPrimitive.ViewportFooter
                data-testid="thread-viewport-footer"
                className="sticky bottom-0 mt-auto z-10 flex flex-col gap-3 overflow-visible bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] pt-1 pb-4"
              >
                {scrollToBottomButton}
                {footer}
              </ThreadPrimitive.ViewportFooter>
            </div>
          )}
        </UnifiedThreadViewport>
        {showMessageNav ? <MessageNav items={userNavItems} scrollContainer={viewportRef} disabled={isRunning} /> : null}
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
      message={message}
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
  const {
    sessionId,
    compactAiOutput,
    isRunning,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    onToggleExpandedTurn,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    pendingTurnId,
  } = useCodeMuxThreadRenderContext();
  return (
    <AssistantLikeMessage
      message={message}
      sessionId={sessionId}
      compactAiOutput={compactAiOutput}
      isRunning={isRunning}
      collapseInfoByEventIndex={collapseInfoByEventIndex}
      expandedTurnKeys={expandedTurnKeys}
      onToggleExpandedTurn={onToggleExpandedTurn}
      toolDurations={toolDurations}
      turnByEventIndex={turnByEventIndex}
      turnOrdinalById={turnOrdinalById}
      pendingTurnId={pendingTurnId}
    />
  );
}

function InterruptBanner() {
  return (
    <div className="mb-4 flex w-full justify-center">
      <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {INTERRUPT_LABEL}
      </div>
    </div>
  );
}

function UserMessage({
  message,
  sourceEventIndex,
  canRewind,
  isRewinding = false,
  rewindModes = [],
  onRewindToMessage,
}: {
  message: MessageState;
  sourceEventIndex?: number;
  canRewind?: boolean;
  isRewinding?: boolean;
  rewindModes?: RewindMode[];
  onRewindToMessage?: (mode: RewindMode) => Promise<void> | void;
}) {
  const text = getMessageText(message);
  const timestamp = getSourceTimestamp(message);
  const [expanded, setExpanded] = useState(false);
  // 窄屏没有 hover:用户消息 footer(时间/复制/回退)常显。
  const isNarrow = useIsNarrowViewport();
  const canCollapse = isLongTranscriptUserMessage(text);
  const imageAttachments = getImageAttachmentItems(message);
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
      <div className="mb-4 flex w-full justify-center">
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
      className="group/message-row mb-3 flex w-full justify-end"
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
            'flex items-center justify-end gap-1 transition-opacity duration-150',
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
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    >
                      {isRewinding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
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
                  <DropdownMenuItem icon={<MessageSquare className="h-3.5 w-3.5" />} onSelect={() => handleRewindSelect('conversation')}>
                    回退对话
                  </DropdownMenuItem>
                ) : null}
                {rewindModes.includes('files') ? (
                  <DropdownMenuItem icon={<FileText className="h-3.5 w-3.5" />} onSelect={() => handleRewindSelect('files')}>
                    回退文件
                  </DropdownMenuItem>
                ) : null}
                {rewindModes.includes('both') ? (
                  <DropdownMenuItem icon={<Layers className="h-3.5 w-3.5" />} onSelect={() => handleRewindSelect('both')}>
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
      className="mb-5 flex w-full justify-end"
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

export function buildUserNavItems(events: AgentMessage[]): UserNavItem[] {
  const userIndexes: number[] = [];

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event.kind !== 'user') continue;

    const text = typeof event.data.content === 'string' ? event.data.content.trim() : '';
    if (text.length === 0 || isInterruptMarker(text)) continue;

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
    if (text) {
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

function getMessageNavMarkerWidth(
  itemIndex: number,
  previewItemIndex: number | null,
  isActive: boolean,
): number {
  if (previewItemIndex == null || previewItemIndex < 0) {
    return isActive ? 8 : 6;
  }

  const distance = Math.abs(itemIndex - previewItemIndex);
  if (distance === 0) return 34;
  if (distance === 1) return 22;
  if (distance === 2) return 14;
  return 7;
}

/** 导航高亮的锚点：滚动容器顶往下 40px（与原实现一致）。 */
const NAV_ACTIVE_ANCHOR_OFFSET_PX = 40;

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

function MessageNav({
  items,
  scrollContainer,
  disabled,
}: {
  items: UserNavItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
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

  if (items.length <= 1) {
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
    // 落点算式与 behavior: 'smooth' 保持原样 —— 另一条工作流在用真实引擎探针测量它们。
    invalidateNavOffsetsRef.current?.();
    const offsetTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({
      top: container.scrollTop + offsetTop - 22,
      behavior: 'smooth',
    });
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
          'pointer-events-auto relative h-full w-full transition-opacity duration-200',
          hovered ? 'opacity-100' : 'opacity-70',
        )}
      >
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
                  'block origin-left rounded-full transition-[width,background-color,opacity] duration-[180ms] ease-out',
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
              <div className="pointer-events-none absolute left-full top-1/2 ml-3 w-80 max-w-[calc(100vw-6rem)] -translate-y-1/2 overflow-hidden rounded-[10px] border border-border/45 bg-[hsl(var(--popover))]/94 px-3 py-2.5 text-popover-foreground shadow-[0_18px_46px_-26px_hsl(var(--surface-shadow-strong)/0.58),0_0_0_1px_hsl(var(--background)/0.45)] backdrop-blur-md animate-in fade-in fill-mode-forwards animation-duration-[220ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
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

function AssistantLikeMessage({
  message,
  sessionId,
  compactAiOutput,
  isRunning,
  collapseInfoByEventIndex,
  expandedTurnKeys,
  onToggleExpandedTurn,
  toolDurations,
  turnByEventIndex,
  turnOrdinalById,
  pendingTurnId,
}: {
  message: MessageState;
  sessionId: string;
  compactAiOutput: boolean;
  isRunning: boolean;
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>;
  expandedTurnKeys: Set<string>;
  onToggleExpandedTurn: (turnKey: string) => void;
  toolDurations: Record<string, number>;
  turnByEventIndex: Map<number, ConversationTurn<AgentMessage>>;
  turnOrdinalById: Map<string, number>;
  pendingTurnId?: string;
}) {
  const forkSession = useSessionStore((state) => state.forkSession);
  const [isForking, setIsForking] = useState(false);
  // The tight mb-2 tail is only for a row that actually sits above the composer.
  // While a turn is running, the last row is followed by the live streaming block
  // (StreamingContent / SubagentRunningRow) and must keep the normal rhythm.
  const isLastRow = useIsLastMessage(message) && !isRunning;
  const collapseInfo = compactAiOutput ? getMessageCollapseInfo(message, collapseInfoByEventIndex) : undefined;
  if (message.content.length === 0 && !collapseInfo?.isToggleMessage) {
    return null;
  }
  const isCollapseExpanded = collapseInfo ? expandedTurnKeys.has(collapseInfo.turnKey) : false;
  const shouldHideCollapsedContent = collapseInfo && !isCollapseExpanded && !collapseInfo.hideReasoningOnly;
  const shouldHideCollapsedReasoning = collapseInfo?.hideReasoningOnly && !isCollapseExpanded;

  if (shouldHideCollapsedContent && !collapseInfo.isToggleMessage) {
    return null;
  }

  const sourceTimestamp = getSourceTimestamp(message);
  const isFinal = message.metadata.custom?.isFinalAssistantMessage === true;
  const sourceRole = message.metadata.custom?.sourceRole === 'system' ? 'system' : 'assistant';
  const turn = getSourceEventIndices(message)
    .map((eventIndex) => turnByEventIndex.get(eventIndex))
    .find((candidate) => candidate?.footerAnchorEventIndex != null);
  const footerStats = turn ? buildFooterStatsFromTurn(turn) : undefined;
  // Main thread footer rule lives in shouldRenderAssistantFooter; grouping /
  // plan cards / data parts stay on this runtime path instead of
  // CodeMuxTranscriptMessage.
  const shouldRenderFooter = shouldRenderAssistantFooter({
    role: sourceRole,
    isFinalAssistantMessage: isFinal,
    turnStatus: turn?.status,
    turnId: turn?.id,
    pendingTurnId,
  });
  const sourceUuid = message.metadata.custom?.sourceUuid as string | undefined;
  const sourceProviderTurnId = message.metadata.custom?.sourceProviderTurnId as string | undefined;
  const sourceProviderTurnOrdinal = turn ? turnOrdinalById.get(turn.id) : undefined;
  const messageText = getMessageText(message);
  const isForkable = shouldRenderFooter
    && !isRunning
    && sourceUuid != null;
  const handleFork = async () => {
    if (!isForkable || !sourceUuid || isForking) return;
    setIsForking(true);
    try {
      await forkSession(
        sessionId,
        sourceUuid,
        sourceUuid,
        sourceProviderTurnId,
        sourceProviderTurnOrdinal,
      );
    } catch {
      // The session store retains the error for the surrounding session UI.
    } finally {
      setIsForking(false);
    }
  };
  const messageBottomSpacing = assistantMessageBottomSpacing({
    isLastRow,
    isToggleMessage: collapseInfo?.isToggleMessage === true,
    shouldRenderFooter,
  });

  return (
    <MessagePrimitive.Root
      data-message-row
      className={cn('group/message-row flex w-full justify-start', messageBottomSpacing)}
    >
      <div
        className={cn(
          'w-full min-w-0 space-y-2 text-sm leading-relaxed',
          message.metadata.custom?.sourceRole === 'system' && 'text-muted-foreground',
        )}
      >
        {collapseInfo?.isToggleMessage ? (
          <AssistantCollapseToggle
            expanded={isCollapseExpanded}
            durationMs={collapseInfo.durationMs}
            onClick={() => onToggleExpandedTurn(collapseInfo.turnKey)}
          />
        ) : null}
        {!shouldHideCollapsedContent ? (
          <MessagePrimitive.GroupedParts groupBy={GROUP_BY_PART} indicator="never">
            {({ part, children }) => {
              switch (part.type) {
                case 'group-thinking':
                  if (shouldHideCollapsedReasoning) {
                    return null;
                  }
                  return (
                    <CodeMuxReasoningGroup
                      startIndex={part.indices[0] ?? 0}
                      endIndex={part.indices[part.indices.length - 1] ?? 0}
                    >
                      {children}
                    </CodeMuxReasoningGroup>
                  );

                case 'group-tool-call': {
                  const toolCalls = part.indices
                    .map((idx) => message.content[idx])
                    .filter((c): c is Extract<typeof c, { type: 'tool-call' }> => c?.type === 'tool-call');
                  const toolNames = toolCalls.map((c) => c.toolName);
                  const toolCallIds = toolCalls.map((c) => c.toolCallId).filter((id): id is string => typeof id === 'string');
                  return (
                    <CodeMuxToolGroup
                      sessionId={sessionId}
                      startIndex={part.indices[0] ?? 0}
                      endIndex={part.indices[part.indices.length - 1] ?? 0}
                      toolNames={toolNames}
                      toolCallIds={toolCallIds}
                    >
                      {children}
                    </CodeMuxToolGroup>
                  );
                }

                case 'text':
                  return (
                    <CodeMuxTextMessagePart
                      text={part.text}
                      parsePlan={isFinal && turn?.status === 'completed'}
                    />
                  );

                case 'reasoning':
                  return <CodeMuxReasoningMessagePart />;

                case 'tool-call':
                  return (
                    <CodeMuxToolCallMessagePart
                      toolName={part.toolName}
                      toolCallId={part.toolCallId}
                      sessionId={sessionId}
                      args={asRecord(part.args)}
                      argsText={part.argsText}
                      result={part.result}
                      isError={part.isError}
                      status={part.status}
                      durationMs={typeof part.toolCallId === 'string' ? toolDurations[part.toolCallId] : undefined}
                    />
                  );

                case 'data':
                  return <CodeMuxDataMessagePart name={part.name} data={part.data} sessionId={sessionId} messageText={messageText} />;

                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        ) : null}
        {!shouldHideCollapsedContent && shouldRenderFooter ? (
          <MessageFooter
            timestamp={sourceTimestamp}
            stats={footerStats}
            revealOnHover
            sessionId={sessionId}
            sourceUuid={sourceUuid}
            canFork={isForkable}
            isForking={isForking}
            onFork={handleFork}
          />
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}

function CodeMuxReasoningGroup({
  children,
  startIndex,
  endIndex,
}: {
  children?: ReactNode;
  startIndex: number;
  endIndex: number;
}) {
  const isRunning = useAuiState((state) => {
    if (state.message.status?.type !== 'running') return false;
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (state.message.parts[index]?.status.type === 'running') return true;
    }
    return false;
  });

  return (
    <ReasoningRoot streaming={isRunning} variant="ghost">
      <ReasoningTrigger active={isRunning} />
      <ReasoningContent aria-busy={isRunning}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function CodeMuxToolGroup({
  children,
  sessionId,
  startIndex,
  endIndex,
  toolNames,
  toolCallIds,
}: {
  children?: ReactNode;
  sessionId?: string;
  startIndex: number;
  endIndex: number;
  toolNames: string[];
  toolCallIds: string[];
}) {
  const isRunning = useAuiState((state) => {
    if (state.message.status?.type !== 'running') return false;
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (state.message.parts[index]?.status.type === 'running') return true;
    }
    return false;
  });
  // A subagent descriptor still running keeps its Agent/Task tool group in the
  // running state even after the parent turn has finished.
  const hasRunningSubagent = useSubagentStore((state) => {
    if (!sessionId || toolCallIds.length === 0) return false;
    const descriptors = state.sessions[sessionId]?.descriptors;
    if (!descriptors) return false;
    return toolCallIds.some((toolCallId) => descriptors[toolCallId]?.status === 'running');
  });

  return (
    <ToolGroup
      startIndex={startIndex}
      endIndex={endIndex}
      toolNames={toolNames}
      active={isRunning || hasRunningSubagent}
      running={hasRunningSubagent}
    >
      {children}
    </ToolGroup>
  );
}

/**
 * Async-agent progress: the parent turn is over but background subagents are
 * still exploring. Without this row the completed result card would make the
 * conversation look finished.
 */
function SubagentRunningRow({ sessionId }: { sessionId: string }) {
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  // 用户停止后子智能体会被置为 failed/canceled,不再有"自动继续"——行要隐藏。
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const runningCount = useSubagentStore((state) => {
    const session = state.sessions[sessionId];
    if (!session) return 0;
    return session.order.filter((id) => session.descriptors[id]?.status === 'running').length;
  });
  // Children all terminal but the parent's summary turn has not settled yet —
  // the flow is still alive from the user's point of view.
  const continuationPending = useSubagentStore((state) => state.continuationPending[sessionId] ?? false);
  // The overall async flow started with the latest user message; keep a live
  // count-up so the wait does not read as a frozen, finished conversation.
  const startedAt = useAgentStore((state) => {
    const sessionEvents = state.events[sessionId];
    const stamps = state.eventTimestamps[sessionId];
    if (!sessionEvents) return undefined;
    for (let index = sessionEvents.length - 1; index >= 0; index -= 1) {
      if (sessionEvents[index].kind === 'user') {
        return stamps?.[index];
      }
    }
    return undefined;
  });

  if (stopped || isRunning || (runningCount === 0 && !continuationPending)) {
    return null;
  }

  const label = runningCount > 0
    ? `子智能体仍在后台运行 ×${runningCount}`
    : '子智能体已完成，主智能体继续输出中';

  return (
    <div className="mb-5 flex w-full justify-start" data-testid="subagent-running-row">
      <div className="flex items-center gap-2 pl-1 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span>
          <RunningElapsedTimer
            label={label}
            startTime={startedAt}
          />
          ，完成后会自动继续
        </span>
      </div>
    </div>
  );
}

/**
 * 流式页脚的"正在执行"状态行。
 *
 * 单独抽成 `memo` 组件，是为了让它彻底脱离分帧绘制的重渲染路径：
 * `StreamingContent` 会随绘制节奏反复重渲染，而这一行里的两处动效都是
 * **绘制类**动画（`DotMatrix` 的 SVG `opacity` 闪烁、`RunningElapsedTimer` 的
 * `.shimmer` 用 `background-clip: text`），无法卸载到合成线程。让它们跟着每帧
 * 重渲染既无意义，也会把主线程预算浪费在重算这一小段 DOM 上。
 * 它的 props 只有 `startTime`，在整个回合内稳定。
 */
const StreamingStatusFooter = memo(function StreamingStatusFooter({
  startTime,
}: {
  startTime?: number;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 py-1 text-sm text-muted-foreground animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]',
      )}
    >
      <DotMatrix state="loading" className="size-4" label="正在执行" />
      <RunningElapsedTimer startTime={startTime} label="正在执行" />
    </div>
  );
});

function StreamingContent({ sessionId, events }: { sessionId: string; events: AgentMessage[] }) {
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

  if (stopped || (!isRunning && !thinking && !visibleText)) {
    return null;
  }

  const isThinking = visibleThinking.length > 0;

  return (
    <div className="mb-5 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-2 text-lg leading-relaxed">
        {isThinking ? (
          <div data-streaming-reasoning="true" className="w-full min-w-0">
            <ReasoningRoot streaming={isRunning} variant="ghost">
              <ReasoningTrigger active={isRunning} />
              <ReasoningContent aria-busy={isRunning}>
                <ReasoningText>
                  <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                    {revealedThinking}
                  </pre>
                </ReasoningText>
              </ReasoningContent>
            </ReasoningRoot>
          </div>
        ) : null}

        {visibleText ? (
          <div
            data-streaming-text="markdown"
            className="relative text-sm leading-6 text-foreground"
          >
            <Streamdown
              mode="streaming"
              {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}
            >
              {revealedText}
            </Streamdown>
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
          </div>
        ) : null}

        {isRunning ? <StreamingStatusFooter startTime={queryStartTime} /> : null}
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
