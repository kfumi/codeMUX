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
import { RunningElapsedTimer, formatElapsed } from '@/components/agent/assistant-ui/RunningElapsed';
import { TooltipHint } from '@/components/ui/tooltip';
import { useTranscriptFollowLatest } from '@/hooks/useTranscriptFollowLatest';
import { parseAgentEvent, useAgentStore, type AgentMessage } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { subagentTabTitle, useSubagentStore } from '@/stores/subagentStore';
 import { EMPTY_ACTIVITY_RUNS, buildActivityRuns } from '@/lib/activityRuns';
import { buildConversationTurns } from '@/lib/conversationTurns';
import { subagentModelFromEvents, subagentStatusLabel } from '@/lib/subagentActivity';
import { supplementSubagentMessagesWithParentSummary } from '@/lib/subagentParentSummary';
import { SUBAGENT_STATUS_TONES } from '@/lib/subagentStatusTone';
import { cn } from '@/lib/utils';

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
  // 处理段的展开状态：未被点过的段跟随 live 自动开合，点过一次后由用户接管。
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());
  const [claimedRunKeys, setClaimedRunKeys] = useState<Set<string>>(() => new Set());

  const isRunning = descriptor?.status === 'running';
  const eventCount = rawEvents?.length ?? 0;

  // 表头第一行取智能体名（`title`，如 `explore`），退回任务描述：参考实现里第一行是
  // 智能体名、第二行才是模型，任务文本留在正文里，不占表头。
  const headerName = useMemo(
    () => descriptor?.title?.trim() || subagentTabTitle(descriptor),
    [descriptor],
  );
  // 模型名来自时间线事件（sidecar 在 `assistant_message` 上补的 `modelID`）；拿不到就
  // 退回 provider（`opencode` / `claude`），与节点卡同一个兜底规则。
  const headerModel = useMemo(() => {
    const fromEvents = subagentModelFromEvents(rawEvents ?? []);
    return fromEvents
      ? { value: fromEvents, source: 'event' as const }
      : { value: descriptor?.provider ?? '', source: 'provider' as const };
  }, [rawEvents, descriptor?.provider]);
  const statusLabel = subagentStatusLabel(descriptor?.status ?? 'running');

  useEffect(() => {
    setExpandedTurnKeys(new Set());
    setExpandedRunKeys(new Set());
    setClaimedRunKeys(new Set());
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

  // 子智能体的处理段（连续思考 + 工具）——与主线程同一套投影。
  const activityRuns = useMemo(() => {
    if (parsedEvents.length === 0) {
      return EMPTY_ACTIVITY_RUNS;
    }
    return buildActivityRuns(
      parsedEvents,
      buildConversationTurns(parsedEvents, { isRunning }),
      timestamps,
      { isRunning },
    );
  }, [parsedEvents, timestamps, isRunning]);

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

  // 计时与主线程对齐：从首条事件起算（重开标签页不清零）。运行中的时长由表头计时器
  // 每秒推进；已结束的直接取首末事件之差，不挂计时器（终态不会再变）。
  const timelineBounds = useMemo(() => {
    let first: number | undefined;
    let last: number | undefined;
    for (const ts of timestamps) {
      if (ts <= 0) continue;
      if (first === undefined) first = ts;
      last = ts;
    }
    return { first, last };
  }, [timestamps]);
  const finishedDuration = timelineBounds.first !== undefined && timelineBounds.last !== undefined
    ? formatElapsed(Math.max(0, timelineBounds.last - timelineBounds.first))
    : '';

  const isEmpty = displayMessages.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col text-ui-body">
      {/* 表头对齐参考实现：第一行智能体名、第二行模型，右侧状态胶囊 + 时长。时长原先
          另画在时间线底部，与这里的胶囊重复，已合并到表头这一处。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/25 px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <div
            data-slot="subagent-panel-title"
            className="truncate text-ui-compact font-semibold text-foreground"
          >
            {headerName}
          </div>
          {headerModel.value ? (
            <div
              data-slot="subagent-panel-model"
              data-model-source={headerModel.source}
              className="truncate text-ui-micro text-muted-foreground"
              title={headerModel.value}
            >
              {headerModel.value}
            </div>
          ) : null}
        </div>
        <span
          data-slot="subagent-panel-status"
          className={cn(
            'shrink-0 rounded-sm px-1.5 py-0.5 text-ui-micro font-medium',
            SUBAGENT_STATUS_TONES[descriptor?.status ?? 'running'].pill,
          )}
        >
          {statusLabel}
        </span>
        <span
          data-slot="subagent-panel-duration"
          className="shrink-0 text-ui-micro text-muted-foreground tabular-nums"
        >
          {isRunning && timelineBounds.first !== undefined ? (
            <RunningElapsedTimer label="" startTime={timelineBounds.first} active={false} />
          ) : (
            finishedDuration
          )}
        </span>
      </div>

      <div
        ref={viewportRef}
        data-testid="subagent-viewport"
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-3"
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
          /* 底部留白放在内容列表上（而不是滚动容器上）：空状态是 `h-full` 居中的，
             滚动容器带不对称内边距会把它顶偏。留白取 56px（pb-14）是为了让开浮起的
             「回到底部」按钮：它 `bottom-4` + `h-8`，占住离底 16–48px 那条带，
             留白比它小时最后一行会被按钮压住。 */
          <div className="space-y-2 pb-14">
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
              // 这一行属于哪个处理段（连续思考 + 工具）：段首画组头，段内只画缩进的步骤行。
              const runPlacement = activityRuns.placementByEventIndex.get(message.metadata.sourceEventIndex);
              const run = runPlacement ? activityRuns.runByKey.get(runPlacement.runKey) : undefined;
              // 未被用户点过的段跟随 live 自动开合：运行中展开、结束后收起；用户点过之后由用户接管。
              const runOpen = run
                ? (claimedRunKeys.has(run.runKey) ? expandedRunKeys.has(run.runKey) : run.live)
                : true;

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
                  run={run}
                  runPlacement={runPlacement}
                  runOpen={runOpen}
                  onToggleRun={run ? () => toggleRun(run.runKey, runOpen) : undefined}
                  collapseInfo={collapseInfo}
                  collapseExpanded={collapseInfo ? expandedTurnKeys.has(collapseInfo.turnKey) : false}
                  onToggleCollapse={collapseInfo
                    ? () => toggleExpandedTurn(collapseInfo.turnKey)
                    : undefined}
                />
              );
            })}
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
