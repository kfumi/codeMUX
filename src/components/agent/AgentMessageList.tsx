import { useEffect, useRef } from 'react';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { TerminalBlock } from './TerminalBlock';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { Loader2 } from 'lucide-react';

interface AgentMessageListProps {
  sessionId: string;
}

function AgentEventItem({ msg }: { msg: AgentMessage }) {
  switch (msg.kind) {
    case 'ready':
      return (
        <div className="text-xs text-muted-foreground py-2">
          Agent 已就绪
        </div>
      );

    case 'system':
      return (
        <div className="text-xs text-muted-foreground py-2 border-b mb-2">
          会话初始化 | 模型: {msg.data.model} | 工具: {msg.data.tools.length} 个
        </div>
      );

    case 'assistant': {
      const blocks = msg.data.message?.content || [];
      return (
        <div className="space-y-1">
          {blocks.map((block, i) => {
            if (block.type === 'thinking' && block.thinking) {
              return <ThinkingBlock key={i} thinking={block.thinking} />;
            }
            if (block.type === 'text' && block.text) {
              return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer content={block.text} />
                </div>
              );
            }
            if (block.type === 'tool_use' && block.name) {
              return (
                <ToolCallCard
                  key={i}
                  toolName={block.name}
                  input={block.input || {}}
                />
              );
            }
            return null;
          })}
        </div>
      );
    }

    case 'tool_result': {
      const results = msg.data.message?.content || [];
      return (
        <div>
          {results.map((r, i) => {
            if (r.type === 'tool_result') {
              const content = r.content || '';
              if (content.length > 200) {
                return (
                  <TerminalBlock
                    key={i}
                    command={`tool_result: ${r.tool_use_id}`}
                    output={content}
                  />
                );
              }
              return (
                <div key={i} className="text-xs text-muted-foreground bg-muted/30 rounded p-2 my-1 whitespace-pre-wrap max-h-40 overflow-auto">
                  {content}
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    case 'result':
      return (
        <div className="border-t pt-2 mt-2 space-y-1">
          <div className="text-sm font-medium">
            {msg.data.subtype === 'success' ? '任务完成' : `任务结束: ${msg.data.subtype}`}
          </div>
          {msg.data.result && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={msg.data.result} />
            </div>
          )}
          <div className="text-xs text-muted-foreground flex gap-4">
            <span>耗时: {(msg.data.duration_ms / 1000).toFixed(1)}s</span>
            <span>轮次: {msg.data.num_turns}</span>
            <span>费用: ${msg.data.total_cost_usd?.toFixed(4)}</span>
            <span>Token: {msg.data.usage?.input_tokens}+{msg.data.usage?.output_tokens}</span>
          </div>
        </div>
      );

    case 'error':
      return (
        <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
          错误: {msg.data.error}
        </div>
      );

    case 'done':
      return null;

    case 'raw':
      return (
        <details className="text-xs text-muted-foreground">
          <summary>原始事件: {String(msg.data.type)}</summary>
          <pre className="mt-1 bg-muted/30 rounded p-2 overflow-auto max-h-32">
            {JSON.stringify(msg.data, null, 2)}
          </pre>
        </details>
      );

    default:
      return null;
  }
}

const EMPTY_EVENTS: AgentMessage[] = [];

export function AgentMessageList({ sessionId }: AgentMessageListProps) {
  const events = useAgentStore((s) => s.events[sessionId] ?? EMPTY_EVENTS);
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] ?? false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-2">
      {events.length === 0 && !isRunning && (
        <div className="text-center text-muted-foreground py-8">
          输入任务描述，让 Claude Agent 自主完成编码工作
        </div>
      )}
      {events.map((msg, i) => (
        <AgentEventItem key={i} msg={msg} />
      ))}
      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Agent 执行中...</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
