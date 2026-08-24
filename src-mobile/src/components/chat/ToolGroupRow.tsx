import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';

import type { ChatMessage } from '../../lib/eventToMessages';
import { buildToolGroupSummary } from '../../lib/toolHeaderSummary';
import { cn } from '../../lib/utils';

interface ToolGroupRowProps {
  toolNames: string[];
  messages: Extract<ChatMessage, { kind: 'tool' }>[];
  renderMessage: (message: ChatMessage) => ReactNode;
  active?: boolean;
}

export function ToolGroupRow({
  toolNames,
  messages,
  renderMessage,
  active = false,
}: ToolGroupRowProps) {
  const [open, setOpen] = useState(active);
  const summary = buildToolGroupSummary(toolNames, toolNames.length);

  useEffect(() => {
    if (active) {
      setOpen(true);
    }
  }, [active]);

  return (
    <div className="w-full py-1" data-active={active ? 'true' : 'false'}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 text-left text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78',
          active && 'text-muted-foreground/80',
        )}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-busy={active || undefined}
      >
        <Wrench className={cn('size-3.5 shrink-0', active && 'text-[hsl(var(--primary)/0.78)]')} />
        <span className="relative inline-block leading-none">
          <span className="inline-flex items-baseline">
            <span>已执行</span>
            {summary ? (
              <>
                <span className="mx-2 select-none">·</span>
                <span>{summary}</span>
              </>
            ) : null}
          </span>
          {active ? (
            <span aria-hidden className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none">
              <span className="inline-flex items-baseline">
                <span>已执行</span>
                {summary ? (
                  <>
                    <span className="mx-2 select-none">·</span>
                    <span>{summary}</span>
                  </>
                ) : null}
              </span>
            </span>
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
        <div className="relative mt-2 pl-5">
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-1 left-2 w-px bg-muted-foreground/18"
          />
          <div className="flex flex-col gap-1.5">
            {messages.map((message) => (
              <div key={message.id}>{renderMessage(message)}</div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
