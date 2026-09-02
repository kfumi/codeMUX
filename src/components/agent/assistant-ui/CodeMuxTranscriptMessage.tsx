import { ChevronRight, ChevronUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import { MessageFooter, type MessageFooterStats, type MessageFooterVariant } from '@/components/assistant-ui/message-footer';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { ToolGroup } from '@/components/assistant-ui/tool-group';
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/reasoning';
import { cn } from '@/lib/utils';

import { CodeMuxToolCallMessagePart } from './CodeMuxMessageParts';
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
};

const TRANSCRIPT_COLLAPSED_USER_MESSAGE_CLASS = 'max-h-80 overflow-hidden';
const ASK_USER_QUESTION_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'askUserQuestion',
  'request_user_input',
  'question',
]);

type ToolCallPart = Extract<CodeMuxAssistantPart, { type: 'tool-call' }>;

type TranscriptPartGroup =
  | { type: 'text'; part: Extract<CodeMuxAssistantPart, { type: 'text' }> }
  | { type: 'reasoning'; part: Extract<CodeMuxAssistantPart, { type: 'reasoning' }> }
  | { type: 'tool-call'; part: ToolCallPart }
  | { type: 'tool-group'; parts: ToolCallPart[] };

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

export function groupTranscriptParts(parts: CodeMuxAssistantPart[]): TranscriptPartGroup[] {
  const groups: TranscriptPartGroup[] = [];
  let toolBuffer: ToolCallPart[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) {
      return;
    }
    if (toolBuffer.length === 1) {
      groups.push({ type: 'tool-call', part: toolBuffer[0] });
    } else {
      groups.push({ type: 'tool-group', parts: toolBuffer });
    }
    toolBuffer = [];
  };

  for (const part of parts) {
    if (part.type === 'tool-call' && !ASK_USER_QUESTION_TOOL_NAMES.has(part.toolName)) {
      toolBuffer.push(part);
      continue;
    }
    flushTools();
    if (part.type === 'text') {
      groups.push({ type: 'text', part });
    } else if (part.type === 'reasoning') {
      groups.push({ type: 'reasoning', part });
    } else if (part.type === 'tool-call') {
      groups.push({ type: 'tool-call', part });
    }
  }
  flushTools();
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
}: TranscriptMessageRenderInput) {
  const text = transcriptMessageText(message);
  const shouldHideCollapsedContent = Boolean(
    collapseInfo && !collapseExpanded && !collapseInfo.hideReasoningOnly,
  );
  const shouldHideCollapsedReasoning = Boolean(
    collapseInfo?.hideReasoningOnly && !collapseExpanded,
  );

  if (shouldHideCollapsedContent && !collapseInfo?.isToggleMessage) {
    return null;
  }

  const footer = showFooter && !shouldHideCollapsedContent
    ? (
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
    )
    : null;

  if (userMode === 'prompt' && message.role === 'user' && message.content[0]?.type === 'text') {
    return (
      <TranscriptUserMessage text={message.content[0].text} footer={footer} />
    );
  }

  if (userMode === 'interactive' && message.role === 'user') {
    return null;
  }

  return (
    <div className="group/message-row">
      {collapseInfo?.isToggleMessage && onToggleCollapse ? (
        <AssistantCollapseToggle
          expanded={collapseExpanded}
          durationMs={collapseInfo.durationMs}
          onClick={onToggleCollapse}
        />
      ) : null}
      {!shouldHideCollapsedContent ? (
        <div className="space-y-2">
          {groupTranscriptParts(message.content).map((group, index) => {
            if (group.type === 'text') {
              return (
                <div key={index} className="pl-1">
                  <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{group.part.text}</Streamdown>
                </div>
              );
            }
            if (group.type === 'reasoning') {
              if (shouldHideCollapsedReasoning) {
                return null;
              }
              return (
                <ReasoningRoot key={index} variant="ghost">
                  <ReasoningTrigger />
                  <ReasoningContent>
                    <ReasoningText>
                      <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{group.part.text}</Streamdown>
                    </ReasoningText>
                  </ReasoningContent>
                </ReasoningRoot>
              );
            }
            if (group.type === 'tool-group') {
              const toolNames = group.parts.map((part) => part.toolName);
              const pending = group.parts.some((part) => part.result === undefined);
              return (
                <ToolGroup
                  key={index}
                  startIndex={0}
                  endIndex={group.parts.length - 1}
                  toolNames={toolNames}
                  active={pending}
                  running={pending}
                >
                  {group.parts.map((part) => (
                    <CodeMuxToolCallMessagePart
                      key={part.toolCallId}
                      toolName={part.toolName}
                      toolCallId={part.toolCallId}
                      sessionId={sessionId}
                      args={part.args}
                      result={part.result}
                      isError={part.isError}
                      durationMs={typeof part.toolCallId === 'string' ? toolDurations?.[part.toolCallId] : undefined}
                    />
                  ))}
                </ToolGroup>
              );
            }
            return (
              <CodeMuxToolCallMessagePart
                key={index}
                toolName={group.part.toolName}
                toolCallId={group.part.toolCallId}
                sessionId={sessionId}
                args={group.part.args}
                result={group.part.result}
                isError={group.part.isError}
                durationMs={typeof group.part.toolCallId === 'string' ? toolDurations?.[group.part.toolCallId] : undefined}
              />
            );
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
        'min-w-0 max-w-full whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border-border/50 bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground',
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
          <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
