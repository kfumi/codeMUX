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
    <div className="rounded-xl bg-gradient-to-br from-[hsl(var(--primary)/0.04)] to-transparent border border-[hsl(var(--primary)/0.08)] my-2 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-[hsl(var(--primary)/0.04)] transition-colors duration-200"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Brain className="h-3.5 w-3.5 text-[hsl(var(--primary)/0.5)]" />
        <span className="text-[13px]">思考过程</span>
        {durationMs != null && (
          <span className="ml-auto text-[11px] text-muted-foreground/40 tabular-nums px-1.5 py-0.5 rounded-md bg-muted/30"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 text-sm text-muted-foreground/80 whitespace-pre-wrap border-t border-[hsl(var(--primary)/0.06)] pt-2.5 animate-fade-in leading-relaxed">
          {thinking}
        </div>
      )}
    </div>
  );
}

/** Streaming thinking block — auto-expands, auto-scrolls, shows pulsing indicator */
export function StreamingThinkingBlock({ thinking }: { thinking: string }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    let parent: HTMLElement | null = el.parentElement;
    let mainContainer: HTMLElement | null = null;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY)) {
        mainContainer = parent;
      }
      parent = parent.parentElement;
    }
    if (!mainContainer) return;
    const distanceFromBottom = mainContainer.scrollHeight - mainContainer.scrollTop - mainContainer.clientHeight;
    if (distanceFromBottom < 300) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [thinking]);

  if (!thinking) return null;

  return (
    <div className="rounded-xl bg-gradient-to-br from-[hsl(var(--primary)/0.04)] to-transparent border border-[hsl(var(--primary)/0.08)] my-2 overflow-hidden animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Brain className="h-3.5 w-3.5 text-[hsl(var(--primary)/0.6)] animate-pulse-soft" />
        <span className="text-[13px]">思考中...</span>
        <div className="ml-auto h-1 w-16 rounded-full bg-[hsl(var(--primary)/0.1)] overflow-hidden">
          <div className="h-full w-1/3 rounded-full bg-[hsl(var(--primary)/0.3)]" style={{ animation: 'shimmer 1.5s ease-in-out infinite', backgroundSize: '200% 100%' }} />
        </div>
      </div>
      <div className="px-3 pb-3 text-sm text-muted-foreground/70 whitespace-pre-wrap border-t border-[hsl(var(--primary)/0.06)] pt-2.5 max-h-96 overflow-y-auto leading-relaxed">
        {thinking}
        <div ref={endRef} />
      </div>
    </div>
  );
}
