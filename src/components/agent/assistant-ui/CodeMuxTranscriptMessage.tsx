import { ChevronRight, ChevronUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import {
  ActivityStepThinking,
} from '@/components/assistant-ui/activity-run';
import { MessageFooter, type MessageFooterStats, type MessageFooterVariant } from '@/components/assistant-ui/message-footer';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { SubagentActivityCard } from '@/components/assistant-ui/subagent-activity';
import { isActivityRunPart, type ActivityRun, type ActivityRunPlacement } from '@/lib/activityRuns';
import { buildSubagentActivity } from '@/lib/subagentActivity';
import { computeBrowserStepContext, type BrowserStepInfo } from '@/lib/browserToolShots';
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
  /** 这一行所属的处理段（连续思考 + 工具）：分组头已移除，仅用于锚定委派卡片。 */
  run?: ActivityRun;
  runPlacement?: ActivityRunPlacement;
  /** 委派卡片当前是否展开。 */
  runOpen?: boolean;
  onToggleRun?: () => void;
};

const TRANSCRIPT_COLLAPSED_USER_MESSAGE_CLASS = 'max-h-80 overflow-hidden';

type ToolCallPart = Extract<CodeMuxAssistantPart, { type: 'tool-call' }>;

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
 * 只读副本的消息行：思考 / 工具 / 正文按源码顺序平铺（分组头已移除，
 * 整轮折叠由「已处理」开关负责）；含委派的行把过程步骤画进委派卡片。
 */
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
  onToggleRun,
}: TranscriptMessageRenderInput) {
  const subagentSession = useSubagentStore((state) => state.sessions[sessionId]);
  const openSubagentInSidePanel = useSubagentStore((state) => state.openInSidePanel);
  // 委派（Task/Agent）：只读副本没有整段的事件下标，所以按
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
  // 整轮折叠（「已处理」开关）负责整轮的显隐。
  const shouldHideCollapsedContent = Boolean(
    collapseInfo && !collapseExpanded && !collapseInfo.hideReasoningOnly,
  );
  const shouldHideCollapsedReasoning = Boolean(
    collapseInfo?.hideReasoningOnly && !collapseExpanded,
  );
  const compactToggle = collapseInfo?.isToggleMessage === true;
  // 委派卡片：只锚定在委派段首行（整轮收起时随整块隐藏），收起态也能开合。
  const delegationCardVisible = run != null
    && runPlacement?.isHead === true
    && (collapseInfo == null || collapseExpanded)
    && subagentActivity != null;
  // 普通步骤行恒可见；只有委派卡片所在的行在卡片收起时让位（步骤归属卡片）。
  const partsVisible = !shouldHideCollapsedContent
    && (subagentActivity == null || delegationCardVisible || runOpen !== false);
  const footerVisible = showFooter && !shouldHideCollapsedContent;

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

  if (!compactToggle && !delegationCardVisible && !partsVisible && !footer) {
    return null;
  }

  const browserStepByIndex = useMemo<(BrowserStepInfo | null)[]>(() => {
    const compact: Array<{ toolName: string; result: unknown }> = [];
    const positions: number[] = [];
    message.content.forEach((part, index) => {
      if (part.type === 'tool-call') {
        positions.push(index);
        compact.push({ toolName: part.toolName, result: part.result });
      }
    });
    const context = computeBrowserStepContext(compact);
    const byIndex: (BrowserStepInfo | null)[] = message.content.map(() => null);
    positions.forEach((position, order) => {
      byIndex[position] = context[order] ?? null;
    });
    return byIndex;
  }, [message.content]);

  const renderToolCall = (
    part: ToolCallPart,
    key: string | number,
  ) => {
    const stepInfo = typeof key === 'number' ? browserStepByIndex[key] : null;
    return (
      <CodeMuxToolCallMessagePart
        key={key}
        toolName={part.toolName}
        toolCallId={part.toolCallId}
        sessionId={sessionId}
        args={part.args}
        result={part.result}
        isError={part.isError}
        durationMs={typeof part.toolCallId === 'string' ? toolDurations?.[part.toolCallId] : undefined}
        browserStep={stepInfo?.step}
        beforeShot={stepInfo?.beforeShot}
        afterShot={stepInfo?.afterShot}
      />
    );
  };

  return (
    <div className="group/message-row">
      {compactToggle && onToggleCollapse ? (
        <AssistantCollapseToggle
          expanded={collapseExpanded}
          durationMs={collapseInfo.durationMs}
          stepCount={collapseInfo.stepCount}
          hasError={collapseInfo.hasError}
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
      ) : null}
      {partsVisible ? (
        <div className="space-y-0.5">
          {message.content.map((part, index) => {
            // 委派卡片所在行：卡片已画出过程步骤，这里只补卡片外的部分（正文 / 问询卡片）。
            if (delegationCardVisible && isActivityRunPart(part)) {
              return null;
            }
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
              'flex items-center justify-end gap-1 transition-opacity duration-fast',
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
