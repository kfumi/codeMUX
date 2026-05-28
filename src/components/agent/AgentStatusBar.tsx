import { useAgentStore } from '../../stores/agentStore';
import { Square, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';

interface AgentStatusBarProps {
  sessionId: string;
}

export function AgentStatusBar({ sessionId }: AgentStatusBarProps) {
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] || false);
  const error = useAgentStore((s) => s.error[sessionId]);
  const events = useAgentStore((s) => s.events[sessionId] || []);
  const interrupt = useAgentStore((s) => s.interrupt);

  const lastResult = [...events].reverse().find((e) => e.kind === 'result');

  if (!isRunning && !error && events.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t bg-muted/30 text-xs">
      {isRunning && (
        <>
          <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
          <span>执行中</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => interrupt()}
          >
            <Square className="h-3 w-3 mr-1" />
            中断
          </Button>
        </>
      )}
      {error && <span className="text-red-500">错误: {error}</span>}
      {lastResult && lastResult.kind === 'result' && (
        <span className="text-muted-foreground">
          完成 | {(lastResult.data.duration_ms / 1000).toFixed(1)}s |
          ${lastResult.data.total_cost_usd?.toFixed(4)}
        </span>
      )}
    </div>
  );
}
