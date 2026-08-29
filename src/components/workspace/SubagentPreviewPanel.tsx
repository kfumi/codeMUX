import { ArrowDown, Bot, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { formatTime } from '@/components/assistant-ui/message-footer';
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/reasoning';
import {
  CodeMuxToolCallMessagePart,
} from '@/components/agent/assistant-ui/CodeMuxMessageParts';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
} from '@/components/agent/assistant-ui/convertAgentEvents';
import { TooltipHint } from '@/components/ui/tooltip';
import { parseAgentEvent } from '@/stores/agentStore';
import { subagentTabTitle, useSubagentStore } from '@/stores/subagentStore';
import { Streamdown } from 'streamdown';
import { Check, Copy } from 'lucide-react';

interface SubagentPreviewPanelProps {
  sessionId: string;
  subagentId: string;
}

/**
 * Read-only real-time preview of one subagent's timeline. There is no
 * Composer, no queued messages, no Stop button: approvals stay in the parent
 * conversation. Loading / footer / auto-scroll follow the main thread.
 */
export function SubagentPreviewPanel({ sessionId, subagentId }: SubagentPreviewPanelProps) {
  const descriptor = useSubagentStore((state) => state.sessions[sessionId]?.descriptors[subagentId]);
  const rawEvents = useSubagentStore((state) => state.sessions[sessionId]?.events[subagentId]);

  const isRunning = descriptor?.status === 'running';
  const eventCount = rawEvents?.length ?? 0;

  const { messages, timestampsByText } = useMemo(() => {
    const parsed = (rawEvents ?? []).map((event) => parseAgentEvent(JSON.stringify(event)));
    const timestamps = parsed.map((_message, index) => {
      const raw = (rawEvents ?? [])[index] as { timestamp?: unknown } | undefined;
      const ts = typeof raw?.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
      return Number.isFinite(ts) ? ts : undefined;
    });
    // convertAgentEventsToAssistantMessages keeps metadata.sourceEventIndex
    // pointing at the first source event of each message.
    const byMessage = new Map<CodeMuxAssistantMessage, number | undefined>();
    const converted = convertAgentEventsToAssistantMessages(parsed);
    for (const message of converted) {
      byMessage.set(message, timestamps[message.metadata.sourceEventIndex]);
    }
    return { messages: converted, timestampsByText: byMessage };
  }, [rawEvents]);

  // Auto-scroll follows the main thread: stick to the bottom while streaming,
  // release when the user scrolls up, offer a jump-back button.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const atBottom = viewport.scrollHeight <= viewport.clientHeight
      || Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
    if (atBottom) {
      followLatestRef.current = true;
    } else if (
      viewport.scrollTop < lastScrollTopRef.current
      && viewport.scrollHeight === lastScrollHeightRef.current
    ) {
      followLatestRef.current = false;
    }
    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    setIsAtBottom(atBottom);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    updateScrollState();
    viewport.addEventListener('scroll', updateScrollState, { passive: true });
    return () => viewport.removeEventListener('scroll', updateScrollState);
  }, [updateScrollState]);

  useEffect(() => {
    if (!followLatestRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport || !followLatestRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTopRef.current = viewport.scrollTop;
      lastScrollHeightRef.current = viewport.scrollHeight;
      setIsAtBottom(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [eventCount, isRunning]);

  const jumpToBottom = () => {
    followLatestRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    setIsAtBottom(true);
  };

  const subtitle = descriptor?.subtitle;
  const isEmpty = messages.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/25 px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-ui-meta text-muted-foreground">
          {subagentTabTitle(descriptor)}
        </span>
        {subtitle ? (
          <span className="ml-auto shrink-0 truncate pl-2 font-mono text-code text-muted-foreground/70">{subtitle}</span>
        ) : null}
      </div>

      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {isRunning ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
                <p className="text-ui-meta text-muted-foreground">子智能体启动中…</p>
              </>
            ) : (
              <>
                <Bot className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-ui-meta text-muted-foreground">没有可显示的子智能体记录</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message, messageIndex) => (
              <SubagentPreviewMessage
                key={message.id}
                message={message}
                sessionId={sessionId}
                timestamp={timestampsByText.get(message)}
                isTimelineRunning={isRunning && messageIndex === messages.length - 1}
              />
            ))}
            {isRunning ? (
              <div className="flex items-center gap-2 pl-1 text-ui-meta text-muted-foreground/72">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>运行中{subtitle ? ` · ${subtitle}` : ''}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!isAtBottom && !isEmpty ? (
        <TooltipHint content="回到底部">
          <button
            type="button"
            aria-label="滚动到底部"
            onClick={jumpToBottom}
            className="absolute bottom-4 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border/50 bg-background/95 text-muted-foreground shadow-md transition-colors hover:text-foreground"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </TooltipHint>
      ) : null}
    </div>
  );
}

function SubagentMessageFooter({ text, timestamp }: { text: string; timestamp?: number }) {
  const [copied, setCopied] = useState(false);

  if (!text && !timestamp) return null;

  return (
    <div
      data-message-footer
      className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/68 opacity-0 transition-opacity duration-150 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100"
    >
      {text ? (
        <TooltipHint content={copied ? '已复制' : '复制'}>
          <button
            type="button"
            aria-label="复制"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                },
                () => undefined,
              );
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </TooltipHint>
      ) : null}
      {timestamp ? (
        <>
          <span className="text-muted-foreground/35">·</span>
          <span className="tabular-nums">{formatTime(timestamp)}</span>
        </>
      ) : null}
    </div>
  );
}

function messageText(message: CodeMuxAssistantMessage): string {
  return message.content
    .map((part) => (part.type === 'text' || part.type === 'reasoning' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function SubagentPreviewMessage({
  message,
  sessionId,
  timestamp,
  isTimelineRunning,
}: {
  message: CodeMuxAssistantMessage;
  sessionId: string;
  timestamp?: number;
  /** True while this message is the tail of a still-running subagent. */
  isTimelineRunning: boolean;
}) {
  const text = messageText(message);
  // Align with the main thread: user messages and completed-turn final
  // assistant messages carry a footer; the running tail doesn't.
  const showFooter = message.role === 'user'
    || (message.metadata.isFinalAssistantMessage === true && !isTimelineRunning);

  if (message.role === 'user' && typeof message.content[0] === 'object' && 'type' in message.content[0] && message.content[0].type === 'text') {
    // The task prompt opening the timeline.
    return (
      <div className="group/message-row">
        <div className="rounded-lg border border-border/45 bg-[hsl(var(--surface-2))]/40 px-3 py-2">
          <p className="whitespace-pre-wrap text-ui-body text-foreground/86">{message.content[0].text}</p>
        </div>
        {showFooter ? <SubagentMessageFooter text={text} timestamp={timestamp} /> : null}
      </div>
    );
  }

  return (
    <div className="group/message-row">
      <div className="space-y-2">
        {message.content.map((part, index) => {
          if (part.type === 'text') {
            return (
              <div key={index} className="pl-1">
                <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{part.text}</Streamdown>
              </div>
            );
          }
          if (part.type === 'reasoning') {
            // Same collapsible thinking block the main thread uses.
            return (
              <ReasoningRoot key={index}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <ReasoningText>
                    <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{part.text}</Streamdown>
                  </ReasoningText>
                </ReasoningContent>
              </ReasoningRoot>
            );
          }
          if (part.type === 'tool-call') {
            return (
              <CodeMuxToolCallMessagePart
                key={index}
                toolName={part.toolName}
                toolCallId={part.toolCallId}
                sessionId={sessionId}
                args={part.args}
                result={part.result}
                isError={part.isError}
              />
            );
          }
          return null;
        })}
      </div>
      {showFooter ? <SubagentMessageFooter text={text} timestamp={timestamp} /> : null}
    </div>
  );
}
