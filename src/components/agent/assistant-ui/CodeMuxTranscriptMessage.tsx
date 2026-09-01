import { Streamdown } from 'streamdown';

import { MessageFooter, type MessageFooterStats, type MessageFooterVariant } from '@/components/assistant-ui/message-footer';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/reasoning';

import { CodeMuxToolCallMessagePart } from './CodeMuxMessageParts';
import type { CodeMuxAssistantMessage } from './convertAgentEvents';

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
};

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
}: TranscriptMessageRenderInput) {
  const text = transcriptMessageText(message);
  const footer = showFooter
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
      <div className="group/message-row">
        <div className="rounded-lg border border-border/45 bg-[hsl(var(--surface-2))]/40 px-3 py-2">
          <p className="whitespace-pre-wrap text-ui-body text-foreground/86">{message.content[0].text}</p>
        </div>
        {footer}
      </div>
    );
  }

  if (userMode === 'interactive' && message.role === 'user') {
    return null;
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
            return (
              <ReasoningRoot key={index} variant="ghost">
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
                durationMs={typeof part.toolCallId === 'string' ? toolDurations?.[part.toolCallId] : undefined}
              />
            );
          }
          return null;
        })}
      </div>
      {footer}
    </div>
  );
}
