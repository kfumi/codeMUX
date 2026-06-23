import {
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAuiState,
  type MessageState,
} from '@assistant-ui/react';
import { ArrowDown, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { MessageFooter, type MessageFooterStats } from '@/components/assistant-ui/message-footer';
import { ToolGroup } from '@/components/assistant-ui/tool-group';
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
import type { Provider } from '../../../types/provider';
import {
  CodeMuxDataMessagePart,
  CodeMuxReasoningMessagePart,
  CodeMuxTextMessagePart,
  CodeMuxToolCallMessagePart,
} from './CodeMuxMessageParts';
import { CodeMuxDirectiveText } from './CodeMuxDirectiveText';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { buildAssistantResultTargetMap } from './assistantResultTargets';
import { RunningElapsedTimer } from './running-elapsed';

type CodeMuxThreadProps = {
  sessionId: string;
  provider?: Provider | null;
  footer?: ReactNode;
};

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TIMESTAMPS: number[] = [];
const INTERRUPT_LABEL = '用户中断请求';
const COLLAPSED_USER_MESSAGE_CLASS = 'max-h-80 overflow-hidden';
const GROUP_BY_PART = groupPartByType({
  reasoning: ['group-thinking'],
  'tool-call': ['group-tool-call'],
});

export function CodeMuxThread({ sessionId, provider, footer }: CodeMuxThreadProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const toolDurations = useMemo(() => buildToolDurationMap(events, eventTimestamps), [events, eventTimestamps]);
  const thinkingDurations = useMemo(
    () => buildThinkingDurationMap(events, eventTimestamps),
    [events, eventTimestamps],
  );
  const resultStatsByAssistantIndex = useMemo(
    () => buildAssistantResultStatsMap(events, provider ?? null),
    [events, provider],
  );
  const userNavItems = useMemo(
    () =>
      events.reduce<Array<{ eventIndex: number; preview: string }>>((items, event, eventIndex) => {
        if (event.kind !== 'user') {
          return items;
        }

        const text = event.data.content.trim();
        if (text.length === 0 || isInterruptMarker(text)) {
          return items;
        }

        items.push({
          eventIndex,
          preview: text.length > 20 ? `${text.slice(0, 20)}...` : text,
        });
        return items;
      }, []),
    [events],
  );

  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col text-sm">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth scrollbar-gutter-stable"
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
                    toolDurations={toolDurations}
                    thinkingDurations={thinkingDurations}
                    resultStatsByAssistantIndex={resultStatsByAssistantIndex}
                  />
                )
              }
            </ThreadPrimitive.Messages>
            {stopped ? <InterruptBanner /> : null}
            <StreamingContent sessionId={sessionId} />
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto z-10 flex flex-col gap-3 overflow-visible bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] pb-4 pt-5 md:pb-6">
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
      <MessageNav items={userNavItems} scrollContainer={viewportRef} />
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

  if (!text) {
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
        <div
          data-user-message-bubble="true"
          className={cn(
            'min-w-0 max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tr-md border border-[hsl(var(--primary)/0.28)] bg-[linear-gradient(180deg,hsl(var(--primary)/0.92),hsl(var(--primary)/0.78))] px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-[0_12px_28px_-20px_hsl(var(--primary)/0.48)] [overflow-wrap:anywhere]',
            canCollapse && !expanded && COLLAPSED_USER_MESSAGE_CLASS,
          )}
        >
          <CodeMuxDirectiveText text={text} tone="inverted" />
        </div>
        {canCollapse ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? '收起' : '查看更多'}
            onClick={() => setExpanded((value) => !value)}
            className="mt-1.5 inline-flex items-center gap-1 self-start rounded-md border border-border/40 bg-muted/28 px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span>{expanded ? '收起' : '查看更多'}</span>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <MessageFooter timestamp={timestamp} className="justify-end" />
      </div>
    </MessagePrimitive.Root>
  );
}

function isLongUserMessage(text: string): boolean {
  return text.length > 900 || text.split(/\r?\n/).length > 12;
}

function MessageNav({
  items,
  scrollContainer,
}: {
  items: Array<{ eventIndex: number; preview: string }>;
  scrollContainer: RefObject<HTMLDivElement | null>;
}) {
  const [hovered, setHovered] = useState(false);
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [navHeight, setNavHeight] = useState(0);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container || items.length === 0) {
      setActiveIdx(null);
      return;
    }

    const updateActive = () => {
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

      setActiveIdx(lastPassed ?? nextUpcoming?.eventIndex ?? items[0]?.eventIndex ?? null);
    };

    updateActive();
    container.addEventListener('scroll', updateActive, { passive: true });
    return () => container.removeEventListener('scroll', updateActive);
  }, [items, scrollContainer]);

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
    const nodeSize = 10;
    const minSpacing = nodeSize + 2;
    const availableHeight = Math.max(navHeight, 48);
    const usableHeight = Math.max(availableHeight - nodeSize, 0);
    const maxVisibleCount =
      availableHeight > 0
        ? Math.max(1, Math.floor(usableHeight / minSpacing) + 1)
        : count;
    const visibleCount = Math.min(count, maxVisibleCount);
    const hiddenCount = Math.max(count - visibleCount, 0);
    const spacing =
      visibleCount <= 1
        ? 0
        : Math.min(usableHeight / Math.max(visibleCount - 1, 1), availableHeight * 0.6 / Math.max(visibleCount - 1, 1));

    return {
      hiddenCount,
      nodeSize: clamp(nodeSize, 10, 10),
      spacing,
      center: availableHeight / 2,
      usableHeight,
      visibleCount,
    };
  }, [items.length, navHeight]);

  const visibleItems = navMetrics.visibleCount >= items.length ? items : items.slice(-navMetrics.visibleCount);
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
      className="pointer-events-none absolute right-1.5 top-0 bottom-0 z-10 flex w-12 items-stretch justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setHoveredBar(null);
      }}
    >
      <div
        className={cn(
          'pointer-events-auto relative h-full w-full transition-opacity duration-200',
          hovered ? 'opacity-100' : 'opacity-55',
        )}
      >
        <div
          className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 rounded-full"
          style={{ background: 'linear-gradient(to bottom, transparent 0%, hsl(var(--border)) 20%, hsl(var(--border)) 80%, transparent 100%)' }}
        />
        {navMetrics.hiddenCount > 0 ? (
          <div className="absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full border border-border/40 bg-background/90 px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground shadow-sm backdrop-blur">
            +{navMetrics.hiddenCount}
          </div>
        ) : null}
        {positionedItems.map((item) => (
          <div
            key={item.eventIndex}
            className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ top: `${item.top}px` }}
          >
            <button
              type="button"
              aria-label={`跳转到消息 ${item.preview}`}
              onMouseEnter={() => setHoveredBar(item.eventIndex)}
              onMouseLeave={() => setHoveredBar(null)}
              onClick={() => scrollToMessage(item.eventIndex)}
              className={cn(
                'rounded-full border transition-all duration-150 hover:scale-105',
                item.eventIndex === activeIdx
                  ? 'border-[hsl(var(--background))] bg-[hsl(var(--primary)/0.82)] shadow-[0_0_0_3px_hsl(var(--background)),0_0_0_4px_hsl(var(--primary)/0.18),0_10px_18px_-12px_hsl(var(--primary)/0.38)]'
                  : 'border-border/70 bg-[hsl(var(--muted-foreground)/0.28)] shadow-[0_0_0_2px_hsl(var(--background)/0.94)] hover:border-[hsl(var(--primary)/0.24)] hover:bg-[hsl(var(--muted-foreground)/0.36)] dark:bg-[hsl(var(--muted-foreground)/0.42)]',
              )}
              style={{
                width: `${navMetrics.nodeSize}px`,
                height: `${navMetrics.nodeSize}px`,
                transform: item.eventIndex === activeIdx ? 'scale(1.08)' : 'scale(1)',
              }}
            />
            {hoveredBar === item.eventIndex ? (
              <div className="pointer-events-none absolute right-full top-1/2 mr-3 max-w-55 -translate-y-1/2 overflow-hidden text-ellipsis whitespace-nowrap rounded-xl border border-border/35 bg-[hsl(var(--popover))]/95 px-3 py-1.5 text-xs text-popover-foreground shadow-[0_12px_32px_-18px_hsl(var(--foreground)/0.45)] backdrop-blur animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]">
                {item.preview}
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
  toolDurations,
  thinkingDurations,
  resultStatsByAssistantIndex,
}: {
  message: MessageState;
  sessionId: string;
  toolDurations: Record<string, number>;
  thinkingDurations: Record<number, number>;
  resultStatsByAssistantIndex: Record<number, MessageFooterStats>;
}) {
  if (message.content.length === 0) {
    return null;
  }

  const sourceEventIndex = getSourceEventIndex(message);
  const thinkingDuration = sourceEventIndex != null ? thinkingDurations[sourceEventIndex] : undefined;
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
        <MessagePrimitive.GroupedParts groupBy={GROUP_BY_PART} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case 'group-thinking':
                return <CodeMuxReasoningGroup durationMs={thinkingDuration}>{children}</CodeMuxReasoningGroup>;

              case 'group-tool-call':
                return (
                  <ToolGroup startIndex={part.indices[0] ?? 0} endIndex={part.indices[part.indices.length - 1] ?? 0}>
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
                  />
                );

              case 'data':
                return <CodeMuxDataMessagePart name={part.name} data={part.data} sessionId={sessionId} />;

              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {shouldRenderFooter ? (
          <MessageFooter timestamp={sourceTimestamp} stats={footerStats} />
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}

function CodeMuxReasoningGroup({
  children,
  durationMs,
}: {
  children?: ReactNode;
  durationMs?: number;
}) {
  const isRunning = useAuiState((state) => state.message.status?.type === 'running');
  const [isOpen, setIsOpen] = useState(isRunning);

  useEffect(() => {
    setIsOpen(isRunning);
  }, [isRunning]);

  return (
    <ReasoningRoot open={isOpen} onOpenChange={setIsOpen} variant="ghost">
      <ReasoningTrigger
        active={isRunning}
        duration={durationMs != null && !isRunning ? Number((durationMs / 1000).toFixed(1)) : undefined}
      />
      <ReasoningContent aria-busy={isRunning}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function StreamingContent({ sessionId }: { sessionId: string }) {
  const stopped = useAgentStore((state) => state.forceStopped[sessionId] ?? false);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const queryStartTime = useAgentStore((state) => state.queryStartTime[sessionId]);
  const thinking = useAgentStore((state) => state.streamingThinking[sessionId] ?? '');
  const text = useAgentStore((state) => state.streamingText[sessionId] ?? '');

  if (stopped || (!isRunning && !thinking && !text)) {
    return null;
  }

  return (
    <div className="mb-5 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-2 text-sm leading-relaxed">
        {thinking && (
          <ReasoningRoot defaultOpen variant="ghost">
            <ReasoningTrigger active />
            <ReasoningContent aria-busy>
              <ReasoningText>
                <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{thinking}</div>
              </ReasoningText>
            </ReasoningContent>
          </ReasoningRoot>
        )}

        {text ? (
          <div className="aui-md relative text-sm leading-6 text-foreground">
            <Streamdown
              mode="streaming"
              plugins={{ code }}
              shikiTheme={["github-light", "github-dark"]}
              parseIncompleteMarkdown
              controls={{ code: { copy: true, download: false }, table: false }}
            >
              {text}
            </Streamdown>
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
          </div>
        ) : null}

        {isRunning ? (
          <div
            className={cn(
              'flex items-center gap-2.5 py-1 text-sm text-muted-foreground/60 animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]',
              !thinking && !text && 'text-muted-foreground',
            )}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--primary)/0.6)]" />
            <RunningElapsedTimer startTime={queryStartTime} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getMessageText(message: MessageState) {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
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

export function buildToolDurationMap(events: AgentMessage[], eventTimestamps: number[]): Record<string, number> {
  const durations: Record<string, number> = {};
  const startTimes: Record<string, number> = {};

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const timestamp = eventTimestamps[index];
    if (!timestamp) continue;

    if (event.kind === 'assistant') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block.id && !startTimes[block.id]) {
          startTimes[block.id] = timestamp;
        }
      }
    }

    if (event.kind === 'tool_result') {
      const data = event.data as unknown as Record<string, unknown>;
      const rawContent = isRecord(data.message) ? data.message.content : undefined;

      if (Array.isArray(rawContent)) {
        for (const result of rawContent) {
          if (!isRecord(result) || result.type !== 'tool_result' || typeof result.tool_use_id !== 'string') {
            continue;
          }

          if (startTimes[result.tool_use_id] && durations[result.tool_use_id] == null) {
            durations[result.tool_use_id] = timestamp - startTimes[result.tool_use_id];
          }
        }
      }

      const toolUseResult = isRecord(data.tool_use_result) ? data.tool_use_result : undefined;
      if (
        toolUseResult &&
        typeof toolUseResult.tool_use_id === 'string' &&
        startTimes[toolUseResult.tool_use_id] &&
        durations[toolUseResult.tool_use_id] == null
      ) {
        durations[toolUseResult.tool_use_id] = timestamp - startTimes[toolUseResult.tool_use_id];
      }

      if (
        typeof data.parent_tool_use_id === 'string' &&
        startTimes[data.parent_tool_use_id] &&
        durations[data.parent_tool_use_id] == null
      ) {
        durations[data.parent_tool_use_id] = timestamp - startTimes[data.parent_tool_use_id];
      }
    }
  }

  for (const event of events) {
    if (event.kind !== 'raw') continue;
    const data = event.data;
    if (data.type !== 'tool_progress') continue;
    const toolUseId = data.tool_use_id;
    const elapsed = data.elapsed_time_seconds;
    if (typeof toolUseId === 'string' && typeof elapsed === 'number') {
      durations[toolUseId] = Math.round(elapsed * 1000);
    }
  }

  for (const event of events) {
    if (event.kind !== 'raw' && event.kind !== 'system') continue;
    const data = event.data as Record<string, unknown>;
    if (data?.type !== 'system' || data?.subtype !== 'task_notification') continue;
    const toolUseId = data.tool_use_id;
    const usage = isRecord(data.usage) ? data.usage : undefined;
    const durationMs = usage?.duration_ms;

    if (typeof toolUseId === 'string' && typeof durationMs === 'number' && durationMs > 0) {
      durations[toolUseId] = durationMs;
    }
  }

  return durations;
}

function buildThinkingDurationMap(events: AgentMessage[], eventTimestamps: number[]): Record<number, number> {
  const durations: Record<number, number> = {};

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind !== 'assistant') continue;

    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const hasThinking = blocks.some((block) => block?.type === 'thinking' && block.thinking);
    if (!hasThinking) continue;

    const startTimestamp = eventTimestamps[index];
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex++) {
      if (eventTimestamps[nextIndex]) {
        durations[index] = eventTimestamps[nextIndex] - startTimestamp;
        break;
      }
    }
  }

  return durations;
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
