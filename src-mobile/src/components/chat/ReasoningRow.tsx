import { Brain, ChevronDown } from 'lucide-react';

import { ChatMarkdown } from './ChatMarkdown';
import { cn } from '../../lib/utils';

interface ReasoningRowProps {
  content: string;
  collapsed: boolean;
  streaming?: boolean;
  onToggle: () => void;
}

export function ReasoningRow({ content, collapsed, streaming, onToggle }: ReasoningRowProps) {
  const isOpen = !collapsed;

  return (
    <div className="w-full py-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <Brain className={cn('size-3.5 shrink-0', streaming && 'animate-pulse text-muted-foreground/72')} />
        <span className="leading-none">思考</span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/52 transition-transform',
            !isOpen && '-rotate-90',
          )}
        />
      </button>
      {isOpen ? (
        <div className="mt-2 max-h-[min(36vh,24rem)] overflow-y-auto pl-5 text-sm leading-relaxed text-muted-foreground">
          <ChatMarkdown content={content} />
        </div>
      ) : null}
    </div>
  );
}
