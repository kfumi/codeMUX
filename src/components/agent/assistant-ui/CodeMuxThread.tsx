import {
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAuiState,
  type MessageState,
} from '@assistant-ui/react';
import { ArrowDown, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Streamdown } from 'streamdown';

import { MessageFooter, type MessageFooterStats } from '@/components/assistant-ui/message-footer';
import { ToolGroup } from '@/components/assistant-ui/tool-group';
import { Button } from '@/components/ui/button';
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/reasoning';
import { cn } from '../../../lib/utils';
import { calculateCost } from '../../../lib/pricing';
import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { isInterruptMarker } from '../../../stores/agentEventParsing';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { Provider } from '../../../types/provider';
import {
  CodeMuxDataMessagePart,
  CodeMuxReasoningMessagePart,
  CodeMuxTextMessagePart,
  CodeMuxToolCallMessagePart,
} from './CodeMuxMessageParts';
import { CodeMuxDirectiveText } from './CodeMuxDirectiveText';
import { buildAssistantResultTargetMap } from './assistantResultTargets';
import { RunningElapsedTimer } from './running-elapsed';
import { ImageAttachmentPreview } from './ImageAttachmentPreview';

type CodeMuxThreadProps = {
  sessionId: string;
  provider?: Provider | null;
  footer?: ReactNode;
};

type AssistantCollapseInfo = {
  turnKey: string;
  isToggleMessage: boolean;
  durationMs?: number;
};

type UserNavItem = {
  eventIndex: number;
  title: string;
  summary: string;
};

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TIMESTAMPS: number[] = [];
const INTERRUPT_LABEL = '用户中断请求';
const COLLAPSED_USER_MESSAGE_CLASS = 'max-h-80 overflow-hidden';
const STREAMING_THINKING_PROTECTION_THRESHOLD = 20_000;
const STREAMING_THINKING_VISIBLE_CHARS = 8_000;
const GROUP_BY_PART = groupPartByType({
  reasoning: ['group-thinking'],
  'tool-call': ['group-tool-call'],
});

export function CodeMuxThread({ sessionId, provider, footer }: CodeMuxThreadProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedTurnKeys(new Set());
  }, [sessionId, compactAiOutput]);

  const toggleExpandedTurn = (turnKey: string) => {
    setExpandedTurnKeys((current) => {
      const next = new Set(current);
      if (next.has(turnKey)) {
        next.delete(turnKey);
      } else {
        next.add(turnKey);
      }
      return next;
    });
  };

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

  // Incremental result stats calculation
  const resultStatsCacheRef = useRef<{ events: AgentMessage[]; provider: Provider | null; result: Record<number, MessageFooterStats> }>({ events: [], provider: null, result: {} });
  const resultStatsByAssistantIndex = useMemo(() => {
    const cache = resultStatsCacheRef.current;
    if (cache.events === events && cache.provider === (provider ?? null)) {
      return cache.result;
    }
    const prevLen = cache.events.length;
    if (prevLen > 0 && prevLen < events.length && cache.events[0] === events[0]) {
      const newResult = incrementAssistantResultStatsMap(cache.result, events, provider ?? null, prevLen);
      resultStatsCacheRef.current = { events, provider: provider ?? null, result: newResult };
      return newResult;
    }
    const newResult = buildAssistantResultStatsMap(events, provider ?? null);
    resultStatsCacheRef.current = { events, provider: provider ?? null, result: newResult };
    return newResult;
  }, [events, provider]);

  const userNavItems = useMemo(() => buildUserNavItems(events), [events]);

  const collapseInfoByEventIndex = useMemo(
    () => buildAssistantCollapseInfoMap(events, eventTimestamps),
    [events, eventTimestamps],
  );

  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col text-sm">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-scroll scrollbar-gutter-stable"
          autoScroll
        >
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col pl-4 pr-14 pt-5">
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === 'user' ? (
                  <UserMessage message={message} sourceEventIndex={getSourceEventIndex(message)} />
                ) : (
                  <AssistantLikeMessage
                    message={message}
                    sessionId={sessionId}
                    compactAiOutput={compactAiOutput}
                    collapseInfoByEventIndex={collapseInfoByEventIndex}
                    expandedTurnKeys={expandedTurnKeys}
                    onToggleExpandedTurn={toggleExpandedTurn}
                    toolDurations={toolDurations}
                    resultStatsByAssistantIndex={resultStatsByAssistantIndex}
                  />
                )
              }
            </ThreadPrimitive.Messages>
            {stopped ? <InterruptBanner /> : null}
            <StreamingContent sessionId={sessionId} events={events} />
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto z-10 flex flex-col gap-3 overflow-visible bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] pt-2 pb-4">
            <ThreadPrimitive.ScrollToBottom
              className="absolute -top-12 left-1/2 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-[hsl(var(--surface-2))] text-muted-foreground shadow-[0_8px_30px_-16px_hsl(var(--foreground)/0.35)] transition-all hover:-translate-y-0.5 hover:text-foreground disabled:invisible"
              aria-label="Scroll to bottom"
              title="Scroll to bottom"
              behavior="smooth"
            >
              <ArrowDown className="h-4 w-4" />
            </ThreadPrimitive.ScrollToBottom>
            {footer}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <MessageNav items={userNavItems} scrollContainer={viewportRef} disabled={isRunning} />
      </div>
    </ThreadPrimitive.Root>
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

function UserMessage({ message, sourceEventIndex }: { message: MessageState; sourceEventIndex?: number }) {
  const text = getMessageText(message);
  const timestamp = getSourceTimestamp(message);
  const [expanded, setExpanded] = useState(false);
  const canCollapse = isLongUserMessage(text);
  const imageAttachments = getImageAttachmentItems(message);

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
      className="mb-5 flex w-full justify-end"
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
          <div
            data-user-message-bubble="true"
            className={cn(
              'min-w-0 max-w-full whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border-border/50 bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground',
              canCollapse && !expanded && COLLAPSED_USER_MESSAGE_CLASS,
            )}
          >
            <CodeMuxDirectiveText text={text} tone="inverted" />
          </div>
        ) : null}
        {canCollapse ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? '收起' : '查看更多'}
            onClick={() => setExpanded((value) => !value)}
            className="mt-1.5 inline-flex items-center gap-1 self-start rounded-md border border-border/40 bg-muted/28 px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span>{expanded ? '收起' : '查看更多'}</span>
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <MessageFooter timestamp={timestamp} className="justify-end" />
      </div>
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

function isLongUserMessage(text: string): boolean {
  return text.length > 900 || text.split(/\r?\n/).length > 12;
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

  return truncateNavText(firstLine, 16);
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
    const markerGap = 8;
    const availableHeight = Math.max(navHeight, 48);
    const stackHeight = Math.min(144, Math.max(48, availableHeight * 0.36));
    const maxVisibleCount =
      availableHeight > 0
        ? Math.max(1, Math.floor((stackHeight - markerHeight) / markerGap) + 1)
        : count;
    const visibleCount = Math.min(count, maxVisibleCount);

    return {
      markerHeight: clamp(markerHeight, 2, 2),
      spacing: markerGap,
      center: availableHeight / 2,
      visibleCount,
    };
  }, [items.length, navHeight]);

  const visibleItems = navMetrics.visibleCount >= items.length ? items : items.slice(-navMetrics.visibleCount);
  const previewItemIndex = previewEventIndex == null
    ? null
    : visibleItems.findIndex((item) => item.eventIndex === previewEventIndex);
  const positionedItems = useMemo(
    () =>
      visibleItems.map((item, index) => ({
        ...item,
        top:
          visibleItems.length <= 1
            ? navMetrics.center
            : navMetrics.center + (index - (visibleItems.length - 1) / 2) * navMetrics.spacing,
    })),
    [navMetrics.spacing, navMetrics.center, visibleItems],
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
      className="pointer-events-none absolute left-3 top-0 bottom-0 z-10 flex w-18 items-stretch justify-start"
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
              <div className="pointer-events-none absolute left-full top-1/2 ml-3 w-[min(20rem,calc(100vw-6rem))] -translate-y-1/2 overflow-hidden rounded-[10px] border border-border/45 bg-[hsl(var(--popover))]/94 px-3 py-2.5 text-popover-foreground shadow-[0_18px_46px_-26px_hsl(var(--foreground)/0.58),0_0_0_1px_hsl(var(--background)/0.45)] backdrop-blur-md animate-in fade-in fill-mode-forwards animation-duration-[220ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
                <div className="truncate text-xs font-semibold leading-5 text-foreground">
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
  collapseInfoByEventIndex,
  expandedTurnKeys,
  onToggleExpandedTurn,
  toolDurations,
  resultStatsByAssistantIndex,
}: {
  message: MessageState;
  sessionId: string;
  compactAiOutput: boolean;
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>;
  expandedTurnKeys: Set<string>;
  onToggleExpandedTurn: (turnKey: string) => void;
  toolDurations: Record<string, number>;
  resultStatsByAssistantIndex: Record<number, MessageFooterStats>;
}) {
  if (message.content.length === 0) {
    return null;
  }

  const sourceEventIndex = getSourceEventIndex(message);
  const collapseInfo = compactAiOutput ? getMessageCollapseInfo(message, collapseInfoByEventIndex) : undefined;
  const isCollapseExpanded = collapseInfo ? expandedTurnKeys.has(collapseInfo.turnKey) : false;
  const shouldHideCollapsedContent = collapseInfo && !isCollapseExpanded;

  if (shouldHideCollapsedContent && !collapseInfo.isToggleMessage) {
    return null;
  }

  const sourceTimestamp = getSourceTimestamp(message);
  const footerStats = sourceEventIndex != null ? resultStatsByAssistantIndex[sourceEventIndex] : undefined;
  const isFinal = message.metadata.custom?.isFinalAssistantMessage === true;
  const shouldRenderFooter =
    isFinal && message.metadata.custom?.sourceRole !== 'system' && (footerStats !== undefined || sourceTimestamp !== undefined);

  return (
    <MessagePrimitive.Root className="mb-5 flex w-full justify-start">
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
                  return <CodeMuxReasoningGroup>{children}</CodeMuxReasoningGroup>;

                case 'group-tool-call':
                  // 如果分组只有一个工具，直接展示工具，不用 ToolGroup
                  if (part.indices.length === 1) {
                    return <>{children}</>;
                  }
                  // Get tool names from message content
                  const toolNames = part.indices
                    .map((idx) => message.content[idx])
                    .filter((c) => c?.type === 'tool-call')
                    .map((c) => (c as { toolName: string }).toolName);
                  return (
                    <ToolGroup startIndex={part.indices[0] ?? 0} endIndex={part.indices[part.indices.length - 1] ?? 0} toolNames={toolNames}>
                      {children}
                    </ToolGroup>
                  );

                case 'text':
                  return <CodeMuxTextMessagePart />;

                case 'reasoning':
                  return <CodeMuxReasoningMessagePart />;

                case 'tool-call':
                  return (
                    <CodeMuxToolCallMessagePart
                      toolName={part.toolName}
                      args={asRecord(part.args)}
                      argsText={part.argsText}
                      result={part.result}
                      isError={part.isError}
                      status={part.status}
                      durationMs={typeof part.toolCallId === 'string' ? toolDurations[part.toolCallId] : undefined}
                      agentId={(part as Record<string, unknown>).agentId as string | undefined}
                      subAgentKey={(part as Record<string, unknown>).subAgentKey as string | undefined}
                      sessionId={sessionId}
                    />
                  );

                case 'data':
                  return <CodeMuxDataMessagePart name={part.name} data={part.data} sessionId={sessionId} />;

                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        ) : null}
        {!shouldHideCollapsedContent && shouldRenderFooter ? (
          <MessageFooter timestamp={sourceTimestamp} stats={footerStats} />
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantCollapseToggle({
  expanded,
  durationMs,
  onClick,
}: {
  expanded: boolean;
  durationMs?: number;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      aria-label={expanded ? '收起AI过程' : '展开AI过程'}
      onClick={onClick}
      className="mb-2 h-8 gap-1.5 rounded-md pl-2 text-xs font-medium text-muted-foreground/80"
    >
      <span>已处理</span>
      {durationMs != null ? <span className="tabular-nums">{formatCompactDuration(durationMs)}</span> : null}
      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </Button>
  );
}

function CodeMuxReasoningGroup({
  children,
}: {
  children?: ReactNode;
}) {
  const isRunning = useAuiState((state) => state.message.status?.type === 'running');
  const [isOpen, setIsOpen] = useState(false);

  return (
    <ReasoningRoot open={isOpen} onOpenChange={setIsOpen} variant="ghost">
      <ReasoningTrigger active={isRunning} />
      <ReasoningContent aria-busy={isRunning}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function StreamingContent({ sessionId, events }: { sessionId: string; events: AgentMessage[] }) {
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const queryStartTime = useAgentStore((state) => state.queryStartTime[sessionId]);
  const thinking = useAgentStore((state) => state.streamingThinking[sessionId] ?? '');
  const text = useAgentStore((state) => state.streamingText[sessionId] ?? '');
  const lastAssistantText = useMemo(() => getLastAssistantText(events), [events]);
  const duplicateLiveText = Boolean(
    text
    && lastAssistantText
    && (
      text === lastAssistantText
      || text.startsWith(lastAssistantText)
      || lastAssistantText.startsWith(text)
    ),
  );
  const visibleText = duplicateLiveText ? '' : text;

  if (stopped || (!isRunning && !thinking && !visibleText)) {
    return null;
  }

  const visibleThinking = getVisibleStreamingThinking(thinking);

  return (
    <div className="mb-5 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-2 text-sm leading-relaxed">
        {thinking && (
          <ReasoningRoot variant="ghost">
            <ReasoningTrigger active tokenCount={Math.ceil(thinking.length / 4)} />
            <ReasoningContent aria-busy>
              <ReasoningText>
                <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{visibleThinking}</div>
              </ReasoningText>
            </ReasoningContent>
          </ReasoningRoot>
        )}

        {visibleText ? (
          <div
            data-streaming-text="markdown"
            className="relative text-sm leading-6 text-foreground"
          >
            <Streamdown mode="streaming" className="aui-md">
              {visibleText}
            </Streamdown>
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
          </div>
        ) : null}

        {isRunning ? (
          <div
            className={cn(
              'flex items-center gap-2.5 py-1 text-sm text-muted-foreground/60 animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]',
              !thinking && !visibleText && 'text-muted-foreground',
            )}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--primary)/0.6)]" />
            <RunningElapsedTimer startTime={queryStartTime} />
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

    return event.data.message.content
      .filter((block): block is { type: 'text'; text: string } =>
        block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('')
      .trim();
  }

  return '';
}

function getVisibleStreamingThinking(thinking: string): string {
  if (thinking.length <= STREAMING_THINKING_PROTECTION_THRESHOLD) {
    return thinking;
  }

  return thinking.slice(-STREAMING_THINKING_VISIBLE_CHARS);
}

function getMessageText(message: MessageState) {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function buildAssistantCollapseInfoMap(
  events: AgentMessage[],
  timestamps: number[],
): Map<number, AssistantCollapseInfo> {
  const resultTargets = buildAssistantResultTargetMap(events);
  const collapseInfoByEventIndex = new Map<number, AssistantCollapseInfo>();

  for (const [finalAssistantIndex, resultIndex] of resultTargets) {
    const userIndex = findTurnUserIndex(events, finalAssistantIndex, resultIndex);
    if (userIndex == null) {
      continue;
    }

    const collapsibleEventIndices: number[] = [];
    for (let index = userIndex + 1; index < finalAssistantIndex; index++) {
      if (isCollapsibleProcessEvent(events[index])) {
        collapsibleEventIndices.push(index);
      }
    }

    if (collapsibleEventIndices.length === 0) {
      continue;
    }

    const turnKey = `${userIndex}-${finalAssistantIndex}-${resultIndex}`;
    const firstCollapsibleIndex = collapsibleEventIndices[0];
    const durationMs = getTurnDurationMs(events, timestamps, userIndex, finalAssistantIndex, resultIndex);

    for (const eventIndex of collapsibleEventIndices) {
      collapseInfoByEventIndex.set(eventIndex, {
        turnKey,
        isToggleMessage: eventIndex === firstCollapsibleIndex,
        durationMs,
      });
    }
  }

  return collapseInfoByEventIndex;
}

function findTurnUserIndex(
  events: AgentMessage[],
  finalAssistantIndex: number,
  resultIndex: number,
): number | undefined {
  const searchStartIndex = Math.min(finalAssistantIndex, resultIndex) - 1;
  for (let index = searchStartIndex; index >= 0; index--) {
    const event = events[index];
    if (event.kind === 'user') {
      return index;
    }
    if (event.kind === 'result') {
      break;
    }
  }

  return undefined;
}

function isCollapsibleProcessEvent(event: AgentMessage | undefined): boolean {
  if (!event) {
    return false;
  }

  return event.kind === 'assistant'
    || event.kind === 'ask_user_question'
    || event.kind === 'api_retry'
    || event.kind === 'compact'
    || event.kind === 'error'
    || event.kind === 'stream_status';
}

function getTurnDurationMs(
  events: AgentMessage[],
  timestamps: number[],
  userIndex: number,
  finalAssistantIndex: number,
  resultIndex: number,
): number | undefined {
  const result = events[resultIndex];
  if (result?.kind === 'result' && typeof result.data.duration_ms === 'number' && result.data.duration_ms > 0) {
    return result.data.duration_ms;
  }

  const startTime = timestamps[userIndex];
  const endTime = timestamps[resultIndex] || timestamps[finalAssistantIndex];
  if (typeof startTime === 'number' && startTime > 0 && typeof endTime === 'number' && endTime > startTime) {
    return endTime - startTime;
  }

  return undefined;
}

function getMessageCollapseInfo(
  message: MessageState,
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>,
): AssistantCollapseInfo | undefined {
  const sourceEventIndices = getSourceEventIndices(message);
  let firstInfo: AssistantCollapseInfo | undefined;
  let hasToggleMessage = false;

  for (const sourceEventIndex of sourceEventIndices) {
    const info = collapseInfoByEventIndex.get(sourceEventIndex);
    if (!info) {
      continue;
    }

    firstInfo ??= info;
    hasToggleMessage = hasToggleMessage || info.isToggleMessage;
  }

  if (!firstInfo) {
    return undefined;
  }

  return {
    ...firstInfo,
    isToggleMessage: hasToggleMessage,
  };
}

function getSourceEventIndices(message: MessageState): number[] {
  const value = message.metadata.custom?.sourceEventIndices;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is number => typeof entry === 'number');
  }

  const sourceEventIndex = getSourceEventIndex(message);
  return sourceEventIndex != null ? [sourceEventIndex] : [];
}

function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
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

function incrementAssistantResultStatsMap(
  prevStats: Record<number, MessageFooterStats>,
  events: AgentMessage[],
  provider: Provider | null,
  fromIndex: number,
): Record<number, MessageFooterStats> {
  const statsMap = { ...prevStats };
  const resultIndexByAssistantIndex = buildAssistantResultTargetMap(events);

  for (const [assistantIndex, resultIndex] of resultIndexByAssistantIndex) {
    // Only process new results
    if (resultIndex < fromIndex) continue;
    const event = events[resultIndex];
    if (event?.kind !== 'result') continue;

    const ltu = (event.data as any).last_token_usage;
    const usage = event.data.usage;
    const usageForCost = ltu
      ? { input_tokens: ltu.input_tokens, output_tokens: ltu.output_tokens, cache_read_input_tokens: ltu.cached_input_tokens ?? 0 }
      : usage;
    statsMap[assistantIndex] = {
      durationMs: event.data.duration_ms,
      numTurns: event.data.num_turns,
      costUsd: calculateCost(usageForCost, provider),
      inputTokens: ltu ? ltu.input_tokens : (usage?.input_tokens || 0),
      outputTokens: ltu ? ltu.output_tokens : (usage?.output_tokens || 0),
      cacheReadTokens: ltu ? (ltu.cached_input_tokens || 0) : (usage?.cache_read_input_tokens || 0),
      cacheCreationTokens: ltu ? 0 : (usage?.cache_creation_input_tokens || 0),
    };
  }

  return statsMap;
}

function buildAssistantResultStatsMap(
  events: AgentMessage[],
  provider: Provider | null,
): Record<number, MessageFooterStats> {
  const statsMap: Record<number, MessageFooterStats> = {};
  const resultIndexByAssistantIndex = buildAssistantResultTargetMap(events);

  for (const [assistantIndex, resultIndex] of resultIndexByAssistantIndex) {
    const event = events[resultIndex];
    if (event?.kind !== 'result') {
      continue;
    }

    const ltu = (event.data as any).last_token_usage;
    const usage = event.data.usage;
    const usageForCost = ltu
      ? { input_tokens: ltu.input_tokens, output_tokens: ltu.output_tokens, cache_read_input_tokens: ltu.cached_input_tokens ?? 0 }
      : usage;
    statsMap[assistantIndex] = {
      durationMs: event.data.duration_ms,
      numTurns: event.data.num_turns,
      costUsd: calculateCost(usageForCost, provider),
      inputTokens: ltu ? ltu.input_tokens : (usage?.input_tokens || 0),
      outputTokens: ltu ? ltu.output_tokens : (usage?.output_tokens || 0),
      cacheReadTokens: ltu ? (ltu.cached_input_tokens || 0) : (usage?.cache_read_input_tokens || 0),
      cacheCreationTokens: ltu ? 0 : (usage?.cache_creation_input_tokens || 0),
    };
  }

  return statsMap;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
