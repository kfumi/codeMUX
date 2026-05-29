import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { Loader2 } from 'lucide-react';

interface AgentStatusBarProps {
  sessionId: string;
}

const EMPTY_EVENTS: AgentMessage[] = [];

export function AgentStatusBar({ sessionId }: AgentStatusBarProps) {
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] ?? false);
  const error = useAgentStore((s) => s.error[sessionId]);
  const events = useAgentStore((s) => s.events[sessionId] ?? EMPTY_EVENTS);

  const lastResult = [...events].reverse().find((e) => e.kind === 'result');

  if (!isRunning && !error && events.length === 0) return null;

  return (
    <div className="border-t border-border/25 py-1.5 shrink-0">
      <div className="max-w-3xl mx-auto flex items-center gap-3 text-xs text-foreground/70"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {isRunning && (
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-[hsl(var(--primary)/0.8)]" />
            <span>running</span>
          </div>
        )}
        {error && <span className="text-red-500">error: {error}</span>}
        {lastResult && lastResult.kind === 'result' && !isRunning && (
          <span>
            done · {(lastResult.data.duration_ms / 1000).toFixed(1)}s · ${lastResult.data.total_cost_usd?.toFixed(4)}
          </span>
        )}
      </div>
    </div>
  );
}
