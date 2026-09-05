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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Streamdown } from 'streamdown';

import { MessageFooter, type MessageFooterStats } from '@/components/assistant-ui/message-footer';
import { ToolGroup } from '@/components/assistant-ui/tool-group';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { isAskUserQuestionToolName } from '@/lib/askUserQuestionTools';
import { useSubagentStore } from '@/stores/subagentStore';
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
import type { ConversationTurn } from '../../../types/conversationTurn';

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
  isToolResultOnlyUserEvent,
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

type UserNavItem = {
  eventIndex: number;
  title: string;
  summary: string;
};

type CodeMuxThreadRenderContextValue = {
  sessionId: string;
  compactAiOutput: boolean;
  isRunning: boolean;
  events: AgentMessage[];
  latestRewindableUserIndex: number | null;
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>;
  expandedTurnKeys: Set<string>;
  onToggleExpandedTurn: (turnKey: string) => void;
  toolDurations: Record<string, number>;
  turnByEventIndex: Map<number, ConversationTurn<AgentMessage>>;
  turnOrdinalById: Map<string, number>;
  /** Session uses subagents and the async flow (children running or parent
   * turn streaming) has not fully settled — footers wait for that moment. */
  subagentFlowPending: boolean;
};

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TURNS: ConversationTurn<AgentMessage>[] = [];
const EMPTY_TIMESTAMPS: number[] = [];
const INTERRUPT_LABEL = '用户中断请求';
const MESSAGE_NAV_HIDE_BREAKPOINT = 860;
const THREAD_CONTENT_PADDING_WITH_NAV = 'px-20';
const THREAD_CONTENT_PADDING_WITHOUT_NAV = 'px-5';
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

  const turnByEventIndex = useMemo(
    () => buildConversationTurnIndex(conversationTurns),
    [conversationTurns],
  );
  const turnOrdinalById = useMemo(
    () => new Map(conversationTurns.map((turn, index) => [turn.id, index])),
    [conversationTurns],
  );
  const sessionHasSubagents = useSubagentStore((state) => (state.sessions[sessionId]?.order.length ?? 0) > 0);
  const hasRunningSubagents = useSubagentStore((state) => {
    const session = state.sessions[sessionId];
    if (!session) return false;
    return session.order.some((id) => session.descriptors[id]?.status === 'running');
  });
  // Continuation turns stream without a sendInput, so isRunning alone misses
  // them — the streaming buffers cover that window.
  const streamingText = useAgentStore((state) => state.streamingText[sessionId] ?? '');
  const streamingThinking = useAgentStore((state) => state.streamingThinking[sessionId] ?? '');
  // Children all terminal but the parent's summary turn has not settled yet:
  // the flow is still running from the user's point of view.
  const continuationPending = useSubagentStore((state) => state.continuationPending[sessionId] ?? false);
  const subagentFlowPending = sessionHasSubagents
    && (hasRunningSubagents || isRunning || continuationPending || streamingText.length > 0 || streamingThinking.length > 0);
  const userNavItems = useMemo(() => buildUserNavItems(events), [events]);
  const userMessageCount = useMemo(
    () => events.reduce((count, event) => count + (event.kind === 'user' ? 1 : 0), 0),
    [events],
  );
  const latestRewindableUserIndex = useMemo(() => findLatestRewindableUserIndex(events), [events]);
  const collapseInfoByEventIndex = useMemo(() => {
    const map = buildAssistantCollapseInfoMap(events, eventTimestamps, {
      allowImplicitResult: !isRunning && !stopped,
    });
    // While the async subagent flow is unsettled the latest turn must keep
    // looking alive — collapsing it into "已处理 32s" reads as finished even
    // though background children are still running.
    if (!subagentFlowPending) {
      return map;
    }
    return omitLatestTurnCollapse(map, events);
  }, [events, eventTimestamps, isRunning, stopped, subagentFlowPending]);

  const threadRenderContextValue = useMemo(() => ({
    sessionId,
    compactAiOutput,
    isRunning,
    events,
    latestRewindableUserIndex,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    onToggleExpandedTurn: toggleExpandedTurn,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    subagentFlowPending,
  }), [
    sessionId,
    compactAiOutput,
    isRunning,
    events,
    latestRewindableUserIndex,
    collapseInfoByEventIndex,
    expandedTurnKeys,
    toggleExpandedTurn,
    toolDurations,
    turnByEventIndex,
    turnOrdinalById,
    subagentFlowPending,
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
          viewportRef={viewportRef}
        >
          {(scrollToBottomButton) => (
            <div
              data-testid="thread-content-shell"
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
                className="sticky bottom-0 mt-auto z-10 flex flex-col gap-3 overflow-visible bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] pt-2 pb-4"
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
  viewportRef,
  children,
}: {
  sessionId: string;
  eventCount: number;
  userMessageCount: number;
  isRunning: boolean;
  viewportRef: RefObject<HTMLDivElement>;
  children: (scrollToBottomButton: ReactNode) => ReactNode;
}) {
  const streamingVersion = useAgentStore((state) => state.streamingVersion[sessionId] ?? 0);
  // 首次非空渲染可能来自已缓存历史，也需要等 assistant-ui 提交消息树。
  const previousEventCountRef = useRef(0);
  const previousUserMessageCountRef = useRef(0);
  const isHistoryHydration = previousEventCountRef.current === 0 && eventCount > 0;
  const hasNewUserMessage = userMessageCount > previousUserMessageCountRef.current;
  const { isAtBottom, scrollToBottom } = useTranscriptFollowLatest({
    viewportRef,
    followKey: `${sessionId}:${eventCount}:${isRunning ? '1' : '0'}:${streamingVersion}:${userMessageCount}`,
    extraFrames: isHistoryHydration || hasNewUserMessage ? 2 : 1,
    forceFollow: hasNewUserMessage,
    behavior: 'smooth',
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

  return (
    <>
      {messageIds.map((messageId) => (
        <ThreadPrimitive.Unstable_MessageById
          key={messageId}
          messageId={messageId}
          components={MESSAGE_COMPONENTS}
        />
      ))}
    </>
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
  const { sessionId, isRunning, events } = useCodeMuxThreadRenderContext();
  const rewindToMessage = useAgentStore((state) => state.rewindToMessage);
  const requestComposerRestore = useAgentStore((state) => state.requestComposerRestore);
  const agentKind = useSessionStore((state) =>
    (state.sessions.find((session) => session.id === sessionId)
      ?? state.archivedSessions.find((session) => session.id === sessionId))?.agent_kind,
  );
  const isReadOnly = useSessionStore((state) =>
    (state.sessions.find((session) => session.id === sessionId)
      ?? state.archivedSessions.find((session) => session.id === sessionId))?.is_read_only ?? false,
  );
  const [isRewinding, setIsRewinding] = useState(false);
  const sourceEventIndex = getSourceEventIndex(message);
  const event = sourceEventIndex != null ? events[sourceEventIndex] : undefined;
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
    subagentFlowPending,
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
      subagentFlowPending={subagentFlowPending}
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
      className="group/message-row mb-5 flex w-full justify-end"
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
        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100">
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
                      className="mt-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:ring-0 disabled:pointer-events-none disabled:opacity-40"
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

function findLatestRewindableUserIndex(events: AgentMessage[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'user') {
      continue;
    }
    const hasText = event.data.content.trim().length > 0;
    const hasAttachments = (event.data.attachments?.length ?? 0) > 0;
    if ((hasText || hasAttachments) && !isInterruptMarker(event.data.content)) {
      return index;
    }
  }

  return null;
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

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container || items.length === 0 || disabled) {
      setActiveIdx(null);
      return;
    }

    let animationFrame: number | null = null;

    const updateActive = () => {
      animationFrame = null;
      const anchorTop = container.getBoundingClientRect().top + 40;
      let lastPassed: number | null = null;
      let nextUpcoming: { eventIndex: number; top: number } | null = null;

      for (const item of items) {
        const element = document.getElementById(`msg-${item.eventIndex}`);
        if (!element) {
          continue;
        }

        const messageTop = element.getBoundingClientRect().top;

        if (messageTop <= anchorTop) {
          lastPassed = item.eventIndex;
          continue;
        }

        if (nextUpcoming == null || messageTop < nextUpcoming.top) {
          nextUpcoming = { eventIndex: item.eventIndex, top: messageTop };
        }
      }

      const nextActiveIdx = lastPassed ?? nextUpcoming?.eventIndex ?? items[0]?.eventIndex ?? null;
      setActiveIdx((current) => (current === nextActiveIdx ? current : nextActiveIdx));
    };

    const scheduleUpdateActive = () => {
      if (animationFrame !== null) {
        return;
      }

      animationFrame = window.requestAnimationFrame(updateActive);
    };

    updateActive();
    container.addEventListener('scroll', scheduleUpdateActive, { passive: true });
    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
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
  subagentFlowPending,
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
  subagentFlowPending: boolean;
}) {
  const forkSession = useSessionStore((state) => state.forkSession);
  const [isForking, setIsForking] = useState(false);
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
  // Public footer rule first; main thread then requires a completed turn,
  // a non-system row, and a settled async subagent flow. `isTimelineRunning`
  // stays false here because parent completion is turn-scoped, not "tail of
  // this message list". Grouping / plan cards / data parts stay on this
  // runtime path instead of CodeMuxTranscriptMessage.
  const shouldRenderFooter =
    shouldShowTranscriptFooter({
      role: sourceRole,
      isFinalAssistantMessage: isFinal,
      isTimelineRunning: false,
    })
    && turn?.status === 'completed'
    && sourceRole !== 'system'
    && !subagentFlowPending
    && turn !== undefined;
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
  const messageBottomSpacing = shouldHideCollapsedContent && collapseInfo?.isToggleMessage
    ? 'mb-4'
    : shouldRenderFooter
      ? 'mb-4'
      : 'mb-5';

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

  if (isRunning || (runningCount === 0 && !continuationPending)) {
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

function StreamingContent({ sessionId, events }: { sessionId: string; events: AgentMessage[] }) {
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const queryStartTime = useAgentStore((state) => state.queryStartTime[sessionId]);
  const thinking = useAgentStore((state) => state.streamingThinking[sessionId] ?? '');
  const text = useAgentStore((state) => state.streamingText[sessionId] ?? '');
  const lastAssistantText = useMemo(() => getLastAssistantText(events), [events]);
  const lastAssistantThinking = useMemo(() => getLastAssistantThinking(events), [events]);
  const hasCommittedThinking = useMemo(
    () => getCurrentTurnCommittedThinking(events) != null,
    [events],
  );
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
  // Prefer reasoning panel: never show live thinking content as answer markdown.
  const visibleThinking = hasCommittedThinking ? '' : (thinking || (textIsMisroutedThinking ? text : ''));
  const visibleText = (
    duplicateLiveText
    || textIsMisroutedThinking
  ) ? '' : text;

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
                    {visibleThinking}
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
              {visibleText}
            </Streamdown>
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
          </div>
        ) : null}

        {isRunning ? (
          <div
            className={cn(
              'flex items-center gap-2.5 py-1 text-sm text-muted-foreground animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]',
            )}
          >
            <DotMatrix state="loading" className="size-5" label="正在执行" />
            <RunningElapsedTimer startTime={queryStartTime} label="正在执行" />
          </div>
        ) : null}
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

function getCurrentTurnCommittedThinking(
  events: AgentMessage[],
): { eventIndex: number; text: string } | undefined {
  let turnStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'user' && !isToolResultOnlyUserEvent(event)) {
      turnStartIndex = index;
      break;
    }
  }

  for (let index = events.length - 1; index > turnStartIndex; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'assistant') {
      continue;
    }

    const thinkingBlock = event.data.message?.content?.find((block) => (
      isRecord(block)
      && block.type === 'thinking'
      && typeof block.thinking === 'string'
      && block.thinking.length > 0
    ));
    if (thinkingBlock && isRecord(thinkingBlock) && typeof thinkingBlock.thinking === 'string') {
      return { eventIndex: index, text: thinkingBlock.thinking };
    }
  }
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
  const durations = { ...prevDurations };

  // Only process new events for tool_progress and task_notification
  for (let index = fromIndex; index < events.length; index++) {
    const event = events[index];

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
