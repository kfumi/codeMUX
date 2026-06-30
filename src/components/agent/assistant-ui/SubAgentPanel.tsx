import { memo, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Bot, Loader2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
  type CodeMuxAssistantPart,
} from './convertAgentEvents';
import {
  CodeMuxDataMessagePart,
  CodeMuxToolCallMessagePart,
} from './CodeMuxMessageParts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

type SubAgentPanelProps = {
  subAgentKey: string;
  historyAgentId?: string;
  sessionId: string;
  prompt?: string;
};

const ANIMATION_DURATION = 200;

/**
 * A collapsible panel that displays sub-agent messages under an Agent tool call.
 * Loads events on demand when expanded for the first time.
 * Reuses the same rendering components as the main agent thread.
 */
function SubAgentPanelImpl({ subAgentKey, historyAgentId, sessionId, prompt }: SubAgentPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1.5 w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/80 transition-colors hover:bg-muted/50 hover:text-muted-foreground">
        <Bot className="size-3.5 shrink-0" />
        <span className="font-medium">子智能体</span>
        {prompt && (
          <span className="ml-1 inline-block max-w-[min(28rem,48vw)] truncate text-muted-foreground/60">
            {prompt}
          </span>
        )}
        <span className="ml-auto">
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden outline-none',
          'data-[state=closed]:animate-collapsible-up',
          'data-[state=open]:animate-collapsible-down',
        )}
        style={{ '--animation-duration': `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      >
        <SubAgentContent subAgentKey={subAgentKey} historyAgentId={historyAgentId} sessionId={sessionId} open={open} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const SubAgentPanel = memo(SubAgentPanelImpl);

type SubAgentContentProps = {
  subAgentKey: string;
  historyAgentId?: string;
  sessionId: string;
  open: boolean;
};

function SubAgentContent({ subAgentKey, historyAgentId, sessionId, open }: SubAgentContentProps) {
  const cacheKey = `${sessionId}:${subAgentKey}`;
  const historyCacheKey = historyAgentId ? `${sessionId}:${historyAgentId}` : undefined;
  const events = useAgentStore((state) => {
    if (historyCacheKey && state.subAgentEvents[historyCacheKey] !== undefined) {
      return state.subAgentEvents[historyCacheKey];
    }
    return state.subAgentEvents[cacheKey];
  });
  const isLoading = useAgentStore((state) =>
    (state.subAgentLoading[cacheKey] ?? false)
    || (historyCacheKey ? state.subAgentLoading[historyCacheKey] ?? false : false),
  );
  const loadSubagentEvents = useAgentStore((state) => state.loadSubagentEvents);

  const isLoaded = useAgentStore((state) => (
    historyCacheKey
      ? state.subAgentEvents[historyCacheKey] !== undefined
      : state.subAgentEvents[cacheKey] !== undefined
  ));

  useEffect(() => {
    if (open && !isLoaded && !isLoading && historyAgentId) {
      loadSubagentEvents(sessionId, historyAgentId);
    }
  }, [open, sessionId, historyAgentId, isLoaded, isLoading, loadSubagentEvents]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/60">
        <Loader2 className="size-3.5 animate-spin" />
        <span>加载子智能体消息中...</span>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground/60">
        {isLoaded ? '未找到子智能体消息' : '等待子智能体消息...'}
      </div>
    );
  }

  return (
    <div className="max-h-128 overflow-y-auto scrollbar-gutter-stable">
      <div className="border-l-2 border-muted-foreground/10 ml-1 pl-3 py-2">
        <SubAgentMessageList events={events} sessionId={sessionId} />
      </div>
    </div>
  );
}

/**
 * Renders sub-agent messages using the same styling as the main agent thread.
 */
function SubAgentMessageList({ events, sessionId }: { events: AgentMessage[]; sessionId: string }) {
  const messages = useMemo(
    () => convertAgentEventsToAssistantMessages(events),
    [events],
  );

  return (
    <>
      {messages.map((msg, i) => (
        <SubAgentMessage key={msg.id || i} message={msg} sessionId={sessionId} />
      ))}
    </>
  );
}

function SubAgentMessage({ message, sessionId }: { message: CodeMuxAssistantMessage; sessionId: string }) {
  if (message.role === 'user') {
    return <SubAgentUserMessage message={message} />;
  }

  if (message.role === 'assistant') {
    return <SubAgentAssistantMessage message={message} sessionId={sessionId} />;
  }

  // Skip system messages
  return null;
}

function SubAgentUserMessage({ message }: { message: CodeMuxAssistantMessage }) {
  const textParts = message.content
    .filter((part): part is Extract<CodeMuxAssistantPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  const text = textParts.join('\n').trim();

  if (!text) return null;

  return (
    <div className="mb-3 flex w-full justify-end">
      <div className="flex w-fit max-w-10/12 min-w-0 flex-col items-end">
        <div className="min-w-0 max-w-full whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border-border/50 bg-muted px-3 py-2 text-[13px] leading-relaxed text-foreground">
          {text}
        </div>
      </div>
    </div>
  );
}

function SubAgentAssistantMessage({ message, sessionId }: { message: CodeMuxAssistantMessage; sessionId: string }) {
  if (message.content.length === 0) return null;

  return (
    <div className="mb-3 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-1.5 text-[13px] leading-relaxed">
        {message.content.map((part, i) => (
          <SubAgentPart key={i} part={part} sessionId={sessionId} />
        ))}
      </div>
    </div>
  );
}

function SubAgentPart({ part, sessionId }: { part: CodeMuxAssistantPart; sessionId: string }) {
  switch (part.type) {
    case 'text':
      return (
        <div className="pl-1">
          <div className="aui-md prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {part.text}
            </ReactMarkdown>
          </div>
        </div>
      );
    case 'reasoning':
      return (
        <div className="text-muted-foreground/70 italic text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {part.text}
          </ReactMarkdown>
        </div>
      );
    case 'tool-call':
      return (
        <CodeMuxToolCallMessagePart
          toolName={part.toolName}
          args={part.args}
          result={part.result}
          isError={part.isError}
          agentId={part.agentId}
          subAgentKey={part.subAgentKey}
          sessionId={sessionId}
        />
      );
    case 'data-codemux-event':
      return <CodeMuxDataMessagePart name="codemux-event" data={{ eventKind: part.eventKind, event: part.event }} sessionId={sessionId} />;
    default:
      return null;
  }
}
