import { ArrowDown, Bot, Loader2 } from 'lucide-react';
import { useMemo, useRef } from 'react';

import {
  CodeMuxTranscriptMessage,
  shouldShowTranscriptFooter,
} from '@/components/agent/assistant-ui/CodeMuxTranscriptMessage';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
} from '@/components/agent/assistant-ui/convertAgentEvents';
import { TooltipHint } from '@/components/ui/tooltip';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { parseAgentEvent } from '@/stores/agentStore';
import { subagentTabTitle, useSubagentStore } from '@/stores/subagentStore';

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

  const { messages, timestampsByMessage } = useMemo(() => {
    const parsed = (rawEvents ?? []).map((event) => parseAgentEvent(JSON.stringify(event)));
    const timestamps = parsed.map((_message, index) => {
      const raw = (rawEvents ?? [])[index] as { timestamp?: unknown } | undefined;
      const ts = typeof raw?.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
      return Number.isFinite(ts) ? ts : undefined;
    });
    const byMessage = new Map<CodeMuxAssistantMessage, number | undefined>();
    const converted = convertAgentEventsToAssistantMessages(parsed);
    for (const message of converted) {
      byMessage.set(message, timestamps[message.metadata.sourceEventIndex]);
    }
    return { messages: converted, timestampsByMessage: byMessage };
  }, [rawEvents]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useTranscriptFollowLatest({
    viewportRef,
    followKey: `${eventCount}:${isRunning ? 'running' : 'idle'}`,
  });

  const subtitle = descriptor?.subtitle;
  const isEmpty = messages.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/25 px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-ui-meta text-muted-foreground">
          {subagentTabTitle(descriptor)}
        </span>
      </div>

      <div
        ref={viewportRef}
        data-testid="subagent-viewport"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
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
              <CodeMuxTranscriptMessage
                key={message.id}
                message={message}
                sessionId={sessionId}
                timestamp={timestampsByMessage.get(message)}
                showFooter={shouldShowTranscriptFooter({
                  role: message.role,
                  isFinalAssistantMessage: message.metadata.isFinalAssistantMessage,
                  isTimelineRunning: isRunning && messageIndex === messages.length - 1,
                })}
                footerVariant="minimal"
                userMode="prompt"
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
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border/50 bg-background/95 text-muted-foreground shadow-md transition-colors hover:text-foreground"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </TooltipHint>
      ) : null}
    </div>
  );
}
