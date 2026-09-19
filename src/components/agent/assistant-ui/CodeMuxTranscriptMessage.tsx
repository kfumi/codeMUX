import { ChevronRight, ChevronUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import {
  ActivityRunHeader,
  ActivityRunSteps,
  ActivityStepThinking,
} from '@/components/assistant-ui/activity-run';
import { MessageFooter, type MessageFooterStats, type MessageFooterVariant } from '@/components/assistant-ui/message-footer';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { isAskUserQuestionToolName } from '@/lib/askUserQuestionTools';
import { SubagentActivityCard } from '@/components/assistant-ui/subagent-activity';
import { isActivityRunPart, type ActivityRun, type ActivityRunPlacement } from '@/lib/activityRuns';
import { buildSubagentActivity } from '@/lib/subagentActivity';
import { useSubagentStore } from '@/stores/subagentStore';
import { cn } from '@/lib/utils';

import { CodeMuxToolCallMessagePart, isSubAgentTool } from './CodeMuxMessageParts';
import {
  AssistantCollapseToggle,
  type AssistantCollapseInfo,
} from './assistantCollapse';
import { CodeMuxDirectiveText } from './CodeMuxDirectiveText';
import type { CodeMuxAssistantMessage, CodeMuxAssistantPart } from './convertAgentEvents';

export type TranscriptFooterVariant = MessageFooterVariant;
export type TranscriptUserMode = 'interactive' | 'prompt';

export type TranscriptMessageRenderInput = {
  message: CodeMuxAssistantMessage;
  sessionId: string;
  timestamp?: number;
  showFooter: boolean;
  footerVariant: TranscriptFooterVariant;
  userMode: TranscriptUserMode;
  toolDurations?: Record<string, number>;
  footerStats?: MessageFooterStats;
  canFork?: boolean;
  isForking?: boolean;
  onFork?: () => void | Promise<void>;
  collapseInfo?: AssistantCollapseInfo;
  collapseExpanded?: boolean;
  onToggleCollapse?: () => void;
  /** 这一行所属的处理段（连续思考 + 工具）。 */
  run?: ActivityRun;
  runPlacement?: ActivityRunPlacement;
  /** 段当前是否展开。 */
  runOpen?: boolean;
  onToggleRun?: () => void;
  /** 这一行之后同一个处理段还有步骤：行距压到段内步距，竖线接上下一行。 */
  runContinuesAfterRow?: boolean;
};

const TRANSCRIPT_COLLAPSED_USER_MESSAGE_CLASS = 'max-h-80 overflow-hidden';

type ToolCallPart = Extract<CodeMuxAssistantPart, { type: 'tool-call' }>;
type ReasoningPart = Extract<CodeMuxAssistantPart, { type: 'reasoning' }>;

/** 处理段内的一个步骤行。 */
export type TranscriptActivityItem =
  | { kind: 'reasoning'; part: ReasoningPart }
  | { kind: 'tool-call'; part: ToolCallPart };

/** 一段连续过程（activity）或一个打断分段的独立部分。 */
export type TranscriptPartGroup =
  | { kind: 'activity'; items: TranscriptActivityItem[] }
  | { kind: 'part'; part: CodeMuxAssistantPart };

export function shouldShowTranscriptFooter(input: {
  role: 'user' | 'assistant' | 'system';
  isFinalAssistantMessage?: boolean;
  isTimelineRunning: boolean;
}): boolean {
  if (input.role === 'user') return true;
  return input.isFinalAssistantMessage === true && !input.isTimelineRunning;
}

export function transcriptMessageText(message: CodeMuxAssistantMessage): string {
  return message.content
    .map((part) => (part.type === 'text' || part.type === 'reasoning' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

export function isLongTranscriptUserMessage(text: string): boolean {
  return text.length > 900 || text.split(/\r?\n/).length > 12;
}

/**
 * 只读副本的分段规则与主线程一致：连续的思考/工具合成一段（处理段），
 * 文本与问询卡片打断分段。渲染侧只有段首画组头，段内平铺缩进的步骤行。
 */
export function groupTranscriptParts(parts: CodeMuxAssistantPart[]): TranscriptPartGroup[] {
  const groups: TranscriptPartGroup[] = [];
  let activity: TranscriptActivityItem[] = [];

  const flushActivity = () => {
    if (activity.length === 0) {
      return;
    }
    groups.push({ kind: 'activity', items: activity });
    activity = [];
  };

  for (const part of parts) {
    if (part.type === 'reasoning') {
      activity.push({ kind: 'reasoning', part });
      continue;
    }
    if (part.type === 'tool-call' && !isAskUserQuestionToolName(part.toolName)) {
      activity.push({ kind: 'tool-call', part });
      continue;
    }
    flushActivity();
    groups.push({ kind: 'part', part });
  }

  flushActivity();
  return groups;
}

export function CodeMuxTranscriptMessage({
  message,
  sessionId,
  timestamp,
  showFooter,
  footerVariant,
  userMode,
  toolDurations,
  footerStats,
  canFork,
  isForking,
  onFork,
  collapseInfo,
  collapseExpanded = false,
  onToggleCollapse,
  run,
  runPlacement,
  runOpen = true,
  runContinuesAfterRow = false,
  onToggleRun,
}: TranscriptMessageRenderInput) {
  const subagentSession = useSubagentStore((state) => state.sessions[sessionId]);
  const openSubagentInSidePanel = useSubagentStore((state) => state.openInSidePanel);
  // 委派（Task/Agent）段：段头改画委派卡片。只读副本没有整段的事件下标，所以按
  // 「本条消息里能按 toolCallId 找到描述符的委派工具调用」判定。
  const subagentActivity = useMemo(() => {
    if (!subagentSession) return undefined;
    const { descriptors, order, events } = subagentSession;
    const subagentIds = order.filter((subagentId) => {
      const toolCallId = descriptors[subagentId]?.toolCallId ?? subagentId;
      if (typeof toolCallId !== 'string') return false;
      return message.content.some((part) => (
        part.type === 'tool-call'
        && part.toolCallId === toolCallId
        && isSubAgentTool(part.toolName)
      ));
    });
    if (subagentIds.length === 0) return undefined;
    return buildSubagentActivity({ order: subagentIds, descriptors, events });
  }, [message.content, subagentSession]);
  const text = transcriptMessageText(message);
  const shouldHideCollapsedContent = Boolean(
    collapseInfo && !collapseExpanded && !collapseInfo.hideReasoningOnly,
  );
  const shouldHideCollapsedReasoning = Boolean(
    collapseInfo?.hideReasoningOnly && !collapseExpanded,
  );
  // 整轮折叠（「已处理」开关）负责整轮的显隐；段自己的折叠在整轮展开后照常工作。
  const compactToggle = collapseInfo?.isToggleMessage === true;
  // 每个处理段都画自己的段组头（段首行正好是整轮开关行时也照画）；整轮收起时随整块隐藏。
  const runHeaderVisible = run != null
    && runPlacement?.isHead === true
    && (collapseInfo == null || collapseExpanded);
  // 与处理段无关、必须始终可见的部分（正文 / 数据卡片 / 问询卡片）。
  const hasIndependentPart = message.content.some((part) => (
    part.type === 'text'
    || part.type === 'data-codemux-event'
    || (part.type === 'tool-call' && isAskUserQuestionToolName(part.toolName))
  ));
  // 段收起时不渲染步骤行；同行里的正文等独立部分由 hasIndependentPart 兜底保持可见。
  const runRowsVisible = !run || runOpen;
  const partsVisible = !shouldHideCollapsedContent && (runRowsVisible || hasIndependentPart);
  const footerVisible = showFooter && !shouldHideCollapsedContent;
  const runDurationMs = run && run.startedAt != null
    ? (run.live ? Date.now() : (run.endedAt ?? run.startedAt)) - run.startedAt
    : undefined;
  // 含委派的段不再画「已处理 N 个步骤」组头，改由卡片承担（收起态也能开合）。
  const delegationCardVisible = runHeaderVisible && run != null && subagentActivity != null;

  const footer = footerVisible ? (
    <MessageFooter
      variant={footerVariant}
      copyText={footerVariant === 'minimal' ? text : undefined}
      timestamp={timestamp}
      stats={footerStats}
      revealOnHover
      sessionId={sessionId}
      canFork={canFork}
      isForking={isForking}
      onFork={onFork}
    />
  ) : null;

  if (userMode === 'prompt' && message.role === 'user' && message.content[0]?.type === 'text') {
    return <TranscriptUserMessage text={message.content[0].text} footer={footer} />;
  }

  if (userMode === 'interactive' && message.role === 'user') {
    return null;
  }

  if (!compactToggle && !runHeaderVisible && !partsVisible && !footer) {
    return null;
  }

  const renderToolCall = (
    part: ToolCallPart,
    key: string | number,
  ) => (
    <CodeMuxToolCallMessagePart
      key={key}
      toolName={part.toolName}
      toolCallId={part.toolCallId}
      sessionId={sessionId}
      args={part.args}
      result={part.result}
      isError={part.isError}
      durationMs={typeof part.toolCallId === 'string' ? toolDurations?.[part.toolCallId] : undefined}
    />
  );

  return (
    <div className="group/message-row">
      {compactToggle && onToggleCollapse ? (
        <AssistantCollapseToggle
          expanded={collapseExpanded}
          durationMs={collapseInfo.durationMs}
          onClick={onToggleCollapse}
        />
      ) : null}
      {delegationCardVisible && run && subagentActivity ? (
        <SubagentActivityCard
          activity={subagentActivity}
          live={run.live || subagentActivity.summary.running > 0}
          open={runOpen}
          onToggle={() => onToggleRun?.()}
          onOpenSubagent={(subagentId) => openSubagentInSidePanel(sessionId, subagentId)}
        >
          {message.content.map((part, index) => {
            if (!isActivityRunPart(part)) return null;
            if (part.type === 'reasoning') {
              return shouldHideCollapsedReasoning ? null : (
                <ActivityStepThinking key={`subagent-step-${index}`} text={part.text} />
              );
            }
            if (part.type === 'tool-call') {
              return renderToolCall(part, `subagent-step-${index}`);
            }
            return null;
          })}
        </SubagentActivityCard>
      ) : runHeaderVisible && run ? (
        <ActivityRunHeader
          open={runOpen}
          onToggle={() => onToggleRun?.()}
          live={run.live}
          onlyThinking={run.onlyThinking}
          durationMs={runDurationMs}
          stepCount={run.stepCount}
          tail={run.tail}
        />
      ) : null}
      {partsVisible ? (
        <div className="space-y-0.5">
          {groupTranscriptParts(message.content).map((group, index) => {
            if (group.kind === 'activity') {
              // 含委派的段：过程步骤已经画进段头的委派卡片（拓扑在前、步骤在后）。
              if (delegationCardVisible) {
                return null;
              }
              // 段收起只收起过程步骤行：同一行里的正文必须始终可见。
              if (!runRowsVisible) {
                return null;
              }
              return (
                <ActivityRunSteps key={index} extendsIntoGap={runContinuesAfterRow}>
                  {group.items.map((item) =>
                    item.kind === 'reasoning' ? (
                      shouldHideCollapsedReasoning ? null : (
                        <ActivityStepThinking
                          key={`thinking-${index}-${item.part.text.slice(0, 24)}`}
                          text={item.part.text}
                        />
                      )
                    ) : (
                      renderToolCall(item.part, `tool-${index}-${item.part.toolCallId}`)
                    ),
                  )}
                </ActivityRunSteps>
              );
            }

            const part = group.part;
            if (part.type === 'text') {
              return (
                <div key={index} className="pl-1">
                  <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{part.text}</Streamdown>
                </div>
              );
            }
            if (part.type === 'reasoning') {
              return shouldHideCollapsedReasoning
                ? null
                : <ActivityStepThinking key={index} text={part.text} />;
            }
            if (part.type === 'tool-call') {
              return renderToolCall(part, index);
            }
            return null;
          })}
        </div>
      ) : null}
      {footer}
    </div>
  );
}

export function TranscriptUserMessageBubble({
  text,
  expanded,
  canCollapse,
}: {
  text: string;
  expanded: boolean;
  canCollapse: boolean;
}) {
  return (
    <div
      data-user-message-bubble="true"
      className={cn(
        'min-w-0 max-w-full whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border-border/50 bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground',
        canCollapse && !expanded && TRANSCRIPT_COLLAPSED_USER_MESSAGE_CLASS,
      )}
    >
      <CodeMuxDirectiveText text={text} tone="inverted" />
    </div>
  );
}

export function TranscriptUserMessageExpandButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? '收起' : '查看更多'}
      onClick={onToggle}
      className="mt-1.5 inline-flex items-center gap-1 self-start rounded-md border border-border/40 bg-muted/28 px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <span>{expanded ? '收起' : '查看更多'}</span>
      {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Shared user-message bubble layout — main thread and read-only subagent previews. */
export function TranscriptUserMessage({
  text,
  footer,
  className,
}: {
  text: string;
  footer?: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // 窄屏没有 hover:用户消息 footer 常显。
  const isNarrow = useIsNarrowViewport();
  const canCollapse = isLongTranscriptUserMessage(text);

  return (
    <div className={cn('group/message-row flex w-full justify-end', className)}>
      <div data-user-message-column="true" className="flex w-fit max-w-10/12 min-w-0 flex-col items-end">
        <TranscriptUserMessageBubble text={text} expanded={expanded} canCollapse={canCollapse} />
        {canCollapse ? (
          <TranscriptUserMessageExpandButton
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {footer ? (
          <div
            className={cn(
              'flex items-center justify-end gap-1 transition-opacity duration-150',
              isNarrow
                ? 'opacity-100'
                : 'opacity-0 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100',
            )}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
