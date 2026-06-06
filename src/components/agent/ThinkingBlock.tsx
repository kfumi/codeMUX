import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

interface ThinkingBlockProps {
  thinking: string;
  durationMs?: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ThinkingBlock({ thinking, durationMs }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinking.trim()) return null;

  return (
    <div className="border rounded-md bg-muted/30 my-2">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span>思考过程</span>
        {durationMs != null && (
          <span className="ml-auto text-xs text-muted-foreground/50 tabular-nums"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 text-sm text-muted-foreground whitespace-pre-wrap border-t pt-2">
          {thinking}
        </div>
      )}
    </div>
  );
}

/** Streaming thinking block — auto-expands, auto-scrolls, shows pulsing indicator */
export function StreamingThinkingBlock({ thinking }: { thinking: string }) {
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom only if user is already near the bottom
  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    // Walk up to find the MAIN scrollable container (skip inner overflow divs).
    // The main container has class "overflow-auto" and holds all messages.
    let parent: HTMLElement | null = el.parentElement;
    let mainContainer: HTMLElement | null = null;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY)) {
        mainContainer = parent; // keep going to find the outermost scrollable
      }
      parent = parent.parentElement;
    }
    if (!mainContainer) return;
    // Only scroll if user is within 300px of the bottom of the main container
    const distanceFromBottom = mainContainer.scrollHeight - mainContainer.scrollTop - mainContainer.clientHeight;
    if (distanceFromBottom < 300) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [thinking]);

  if (!thinking) return null;

  return (
    <div className="border rounded-md bg-muted/30 my-2 animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Brain className="h-4 w-4 animate-pulse text-[hsl(var(--primary)/0.7)]" />
        <span>思考中...</span>
      </div>
      <div className="px-3 pb-3 text-sm text-muted-foreground whitespace-pre-wrap border-t pt-2 max-h-96 overflow-y-auto">
        {thinking}
        <div ref={endRef} />
      </div>
    </div>
  );
}
