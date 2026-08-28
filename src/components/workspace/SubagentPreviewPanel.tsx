import { Bot } from 'lucide-react';
import { useMemo } from 'react';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import {
  CodeMuxToolCallMessagePart,
} from '@/components/agent/assistant-ui/CodeMuxMessageParts';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
} from '@/components/agent/assistant-ui/convertAgentEvents';
import { parseAgentEvent } from '@/stores/agentStore';
import { subagentTabTitle, useSubagentStore } from '@/stores/subagentStore';
import { Streamdown } from 'streamdown';

interface SubagentPreviewPanelProps {
  sessionId: string;
  subagentId: string;
}

/**
 * Read-only real-time preview of one subagent's timeline. There is no
 * Composer, no queued messages, no Stop button: approvals stay in the parent
 * conversation.
 */
export function SubagentPreviewPanel({ sessionId, subagentId }: SubagentPreviewPanelProps) {
  const descriptor = useSubagentStore((state) => state.sessions[sessionId]?.descriptors[subagentId]);
  const rawEvents = useSubagentStore((state) => state.sessions[sessionId]?.events[subagentId]);

  const messages = useMemo(() => {
    const parsed = (rawEvents ?? []).map((event) => parseAgentEvent(JSON.stringify(event)));
    return convertAgentEventsToAssistantMessages(parsed);
  }, [rawEvents]);

  const subtitle = descriptor?.subtitle;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/25 px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-ui-meta text-muted-foreground">
          {subagentTabTitle(descriptor)}
        </span>
        {subtitle ? (
          <span className="ml-auto shrink-0 font-mono text-code text-muted-foreground/70">{subtitle}</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Bot className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-ui-meta text-muted-foreground">没有可显示的子智能体记录</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <SubagentPreviewMessage key={message.id} message={message} sessionId={sessionId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SubagentPreviewMessage({ message, sessionId }: { message: CodeMuxAssistantMessage; sessionId: string }) {
  if (message.role === 'user' && typeof message.content[0] === 'object' && 'type' in message.content[0] && message.content[0].type === 'text') {
    // The task prompt opening the timeline.
    return (
      <div className="rounded-lg border border-border/45 bg-[hsl(var(--surface-2))]/40 px-3 py-2">
        <p className="whitespace-pre-wrap text-ui-body text-foreground/86">{message.content[0].text}</p>
      </div>
    );
  }

  return (
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
            <div key={index} className="pl-1 text-muted-foreground/72">
              <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{part.text}</Streamdown>
            </div>
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
  );
}
