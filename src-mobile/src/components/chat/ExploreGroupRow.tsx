import { useState, type ReactNode } from 'react';
import { ChevronDown, Compass, Loader2 } from 'lucide-react';

import type { ChatMessage } from '../../lib/eventToMessages';
import { buildToolGroupSummary } from '../../lib/toolHeaderSummary';
import { cn } from '../../lib/utils';
import { ThinkingGroupRow } from './ThinkingGroupRow';

interface ExploreGroupRowProps {
  toolNames: string[];
  messages: ChatMessage[];
  renderMessage: (message: ChatMessage) => ReactNode;
  active?: boolean;
}

type ExploreContent =
  | {
      kind: 'thinking';
      id: string;
      messages: Extract<ChatMessage, { kind: 'reasoning' }>[];
    }
  | { kind: 'message'; message: ChatMessage };

function buildExploreContents(messages: ChatMessage[]): ExploreContent[] {
  const contents: ExploreContent[] = [];
  let reasoningMessages: Extract<ChatMessage, { kind: 'reasoning' }>[] = [];

  const flushReasoning = () => {
    if (reasoningMessages.length === 0) {
      return;
    }
    contents.push({
      kind: 'thinking',
      id: reasoningMessages[0]?.id ?? `thinking-${contents.length}`,
      messages: reasoningMessages,
    });
    reasoningMessages = [];
  };

  for (const message of messages) {
    if (message.kind === 'reasoning') {
      reasoningMessages.push(message);
      continue;
    }
    flushReasoning();
    contents.push({ kind: 'message', message });
  }

  flushReasoning();
  return contents;
}

export function ExploreGroupRow({
  toolNames,
  messages,
  renderMessage,
  active = false,
}: ExploreGroupRowProps) {
  const [open, setOpen] = useState(false);
  const summary = buildToolGroupSummary(toolNames, toolNames.length);
  const contents = buildExploreContents(messages);

  return (
    <div className="w-full py-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Compass className="size-3.5 shrink-0" />
        {active ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
        <span className="leading-none">
          探索
          {summary ? (
            <>
              <span className="mx-2 select-none">·</span>
              <span>{summary}</span>
            </>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground/52 transition-transform',
            !open && '-rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="mt-2 space-y-2 border-l border-muted-foreground/18 pl-5">
          {contents.map((content) => (
            <div key={content.kind === 'thinking' ? content.id : content.message.id}>
              {content.kind === 'thinking' ? (
                <ThinkingGroupRow messages={content.messages} />
              ) : (
                renderMessage(content.message)
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
