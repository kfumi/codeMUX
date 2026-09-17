import { ArrowDown, Bot, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildAssistantCollapseInfoMap,
  getCollapseInfoForSourceIndices,
  omitLatestTurnCollapse,
} from '@/components/agent/assistant-ui/assistantCollapse';
import {
  CodeMuxTranscriptMessage,
  shouldShowTranscriptFooter,
} from '@/components/agent/assistant-ui/CodeMuxTranscriptMessage';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
} from '@/components/agent/assistant-ui/convertAgentEvents';
import { RunningElapsedTimer } from '@/components/agent/assistant-ui/RunningElapsed';
import { TooltipHint } from '@/components/ui/tooltip';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { parseAgentEvent, useAgentStore, type AgentMessage } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { subagentTabTitle, useSubagentStore } from '@/stores/subagentStore';
import { supplementSubagentMessagesWithParentSummary } from '@/lib/subagentParentSummary';

interface SubagentPreviewPanelProps {
  sessionId: string;
  subagentId: string;
}

const EMPTY_PARENT_EVENTS: AgentMessage[] = [];

/**
 * Read-only real-time preview of one subagent's timeline. There is no
 * Composer, no queued messages, no Stop button: approvals stay in the parent
 * conversation. Loading / footer / auto-scroll follow the main thread.
 */
export function SubagentPreviewPanel({ sessionId, subagentId }: SubagentPreviewPanelProps) {
  const descriptor = useSubagentStore((state) => state.sessions[sessionId]?.descriptors[subagentId]);
  const rawEvents = useSubagentStore((state) => state.sessions[sessionId]?.events[subagentId]);
  const parentEvents = useAgentStore((state) => state.events[sessionId] ?? EMPTY_PARENT_EVENTS);
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Set<string>>(() => new Set());

  const isRunning = descriptor?.status === 'running';
  const eventCount = rawEvents?.length ?? 0;

  useEffect(() => {
    setExpandedTurnKeys(new Set());
  }, [sessionId, subagentId, compactAiOutput]);

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

  const { messages, timestampsByMessage, parsedEvents, timestamps } = useMemo(() => {
    // parseAgentEvent accepts the raw object directly; the old
    // JSON.stringify round-trip re-serialized every subagent event only for the
    // parser to deserialize it again.
    const parsed = (rawEvents ?? []).map((event) => parseAgentEvent(event));
    const parsedTimestamps = parsed.map((_message, index) => {
      const raw = (rawEvents ?? [])[index] as { timestamp?: unknown } | undefined;
      const ts = typeof raw?.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
      return Number.isFinite(ts) ? ts : 0;
    });
    const byMessage = new Map<CodeMuxAssistantMessage, number | undefined>();
    const converted = convertAgentEventsToAssistantMessages(parsed);
    for (const message of converted) {
      const ts = parsedTimestamps[message.metadata.sourceEventIndex];
      byMessage.set(message, ts > 0 ? ts : undefined);
    }
    return {
      messages: converted,
      timestampsByMessage: byMessage,
      parsedEvents: parsed,
      timestamps: parsedTimestamps,
    };
  }, [rawEvents]);

  const displayMessages = useMemo(
    () => supplementSubagentMessagesWithParentSummary(
      messages,
      parentEvents,
      descriptor?.toolCallId ?? subagentId,
      { isRunning },
    ),
    [messages, parentEvents, descriptor?.toolCallId, subagentId, isRunning],
  );

  const collapseInfoByEventIndex = useMemo(() => {
    if (!compactAiOutput) {
      return new Map();
    }
    const map = buildAssistantCollapseInfoMap(parsedEvents, timestamps, {
      allowImplicitResult: !isRunning,
    });
    // The live turn must keep looking alive — collapsing it into "已处理"
    // reads as finished even though this subagent is still running.
    return isRunning ? omitLatestTurnCollapse(map, parsedEvents) : map;
  }, [compactAiOutput, parsedEvents, timestamps, isRunning]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useTranscriptFollowLatest({
    viewportRef,
    followKey: `${eventCount}:${isRunning ? 'running' : 'idle'}`,
  });

  // 计时与主线程对齐：从首条事件时间起算，重开标签页不清零。
  const runningStartTs = useMemo(() => timestamps.find((ts) => ts > 0), [timestamps]);

  const isEmpty = displayMessages.length === 0;

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
            {displayMessages.map((message, messageIndex) => {
              const collapseInfo = compactAiOutput
                ? getCollapseInfoForSourceIndices(
                  message.metadata.sourceEventIndices,
                  collapseInfoByEventIndex,
                  {
                    hasReasoning: message.content.some((part) => part.type === 'reasoning'),
                    isSplitHead: message.metadata.isSplitHead,
                  },
                )
                : undefined;
              return (
                <CodeMuxTranscriptMessage
                  key={message.id}
                  message={message}
                  sessionId={sessionId}
                  timestamp={timestampsByMessage.get(message)}
                  showFooter={shouldShowTranscriptFooter({
                    role: message.role,
                    isFinalAssistantMessage: message.metadata.isFinalAssistantMessage,
                    isTimelineRunning: isRunning && messageIndex === displayMessages.length - 1,
                  })}
                  footerVariant="minimal"
                  userMode="prompt"
                  collapseInfo={collapseInfo}
                  collapseExpanded={collapseInfo ? expandedTurnKeys.has(collapseInfo.turnKey) : false}
                  onToggleCollapse={collapseInfo
                    ? () => toggleExpandedTurn(collapseInfo.turnKey)
                    : undefined}
                />
              );
            })}
            {isRunning ? (
              <div className="flex items-center gap-2 pl-1 text-ui-meta text-muted-foreground/72">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <RunningElapsedTimer label="运行中" startTime={runningStartTs} />
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
