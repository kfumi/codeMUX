import { useEffect, useRef, useState, useCallback } from 'react';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { TerminalBlock } from './TerminalBlock';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { Loader2, Sparkles, ArrowDown } from 'lucide-react';

interface AgentMessageListProps {
  sessionId: string;
}

function AgentEventItem({ msg }: { msg: AgentMessage }) {
  try {
    return renderEvent(msg);
  } catch (err) {
    return (
      <div className="text-xs text-red-500 bg-red-500/[0.06] rounded-xl p-3 my-1 border border-red-500/15">
        渲染错误: {String(err)}
        <pre className="mt-1 text-[10px] opacity-50">{JSON.stringify(msg, null, 2).slice(0, 200)}</pre>
      </div>
    );
  }
}

function renderEvent(msg: AgentMessage) {
  switch (msg.kind) {
    case 'user':
      return (
        <div className="flex justify-end animate-fade-in-up">
          <div className="max-w-[80%] bg-primary/10 text-foreground rounded-2xl rounded-tr-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
            {msg.data.content}
          </div>
        </div>
      );

    case 'ready':
      return (
        <div className="text-xs text-muted-foreground/60 py-2 px-1 animate-fade-in">
          Agent 已就绪
        </div>
      );

    case 'system':
      return (
        <div className="text-xs text-muted-foreground py-2 px-1 border-b border-border/20 mb-4 animate-fade-in"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          会话初始化 · 模型: {msg.data.model || '未知'} · 工具: {Array.isArray(msg.data.tools) ? msg.data.tools.length : 0} 个
        </div>
      );

    case 'assistant': {
      const rawBlocks = msg.data.message?.content;
      const blocks = Array.isArray(rawBlocks) ? rawBlocks : typeof rawBlocks === 'string' ? [{ type: 'text', text: rawBlocks }] : [];
      return (
        <div className="space-y-3 animate-fade-in-up">
          {blocks.map((block: any, i: number) => {
            if (block?.type === 'thinking' && block.thinking) {
              return <ThinkingBlock key={i} thinking={block.thinking} />;
            }
            if (block?.type === 'text' && block.text) {
              return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none leading-[1.7]">
                  <MarkdownRenderer content={block.text} />
                </div>
              );
            }
            if (block?.type === 'tool_use' && block.name) {
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
      const rawContent: any = msg.data.message?.content;
      if (typeof rawContent === 'string') {
        if (rawContent.length > 200) {
          return <TerminalBlock command="tool_result" output={rawContent} />;
        }
        return (
          <div className="text-xs text-muted-foreground bg-muted/30 rounded-xl p-3 my-1.5 whitespace-pre-wrap max-h-40 overflow-auto border border-border/20"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {rawContent}
          </div>
        );
      }
      const results = Array.isArray(rawContent) ? rawContent : [];
      return (
        <div>
          {results.map((r: any, i: number) => {
            if (r?.type === 'tool_result') {
              const content = r.content || '';
              if (typeof content === 'string' && content.length > 200) {
                return (
                  <TerminalBlock
                    key={i}
                    command={`tool_result: ${r.tool_use_id}`}
                    output={content}
                  />
                );
              }
              return (
                <div key={i} className="text-xs text-muted-foreground bg-muted/30 rounded-xl p-3 my-1.5 whitespace-pre-wrap max-h-40 overflow-auto border border-border/20"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {typeof content === 'string' ? content : JSON.stringify(content)}
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
        <div className="border-t border-border/20 pt-4 mt-4 space-y-2.5 animate-fade-in-up">
          <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
            {msg.data.subtype === 'success' ? (
              <>
                <div className="w-4 h-4 rounded-full bg-emerald-500/15 flex items-center justify-center">
                  <Sparkles className="h-2.5 w-2.5 text-emerald-500" />
                </div>
                任务完成
              </>
            ) : (
              `任务结束: ${msg.data.subtype}`
            )}
          </div>
          {msg.data.result && (
            <div className="prose prose-sm dark:prose-invert max-w-none leading-[1.7]">
              <MarkdownRenderer content={msg.data.result} />
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground/60 pt-1"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <span>耗时 {(msg.data.duration_ms / 1000).toFixed(1)}s</span>
            <span>轮次 {msg.data.num_turns}</span>
            <span>${msg.data.total_cost_usd?.toFixed(4)}</span>
            <span>{msg.data.usage?.input_tokens}+{msg.data.usage?.output_tokens} token</span>
          </div>
        </div>
      );

    case 'error':
      return (
        <div className="text-sm text-red-500 bg-red-500/[0.06] rounded-xl p-3 border border-red-500/15 animate-fade-in">
          错误: {msg.data.error}
        </div>
      );

    case 'done':
      return null;

    case 'raw':
      // 隐藏 sidecar 调试信息，不在对话中展示
      if (msg.data.type === 'sidecar_debug') {
        return null;
      }
      return (
        <details className="text-xs text-muted-foreground/50 group">
          <summary className="cursor-pointer hover:text-muted-foreground transition-colors">
            原始事件: {String(msg.data.type)}
          </summary>
          <pre className="mt-1.5 bg-muted/20 rounded-xl p-3 overflow-auto max-h-32 border border-border/15"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 用户主动点击回到底部后，恢复自动滚动
  const [autoScroll, setAutoScroll] = useState(true);
  // 跟踪上一次事件数量，用于区分历史加载和实时消息
  const prevCountRef = useRef(0);

  // 监听滚动位置 - 只在有内容、内容溢出、且用户上滚时才显示按钮
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasContent = events.length > 0 || isRunning;
    if (!hasContent) {
      setShowScrollBtn(false);
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distanceFromBottom < 50;
    const hasOverflow = el.scrollHeight > el.clientHeight;
    setShowScrollBtn(hasOverflow && distanceFromBottom > 200);
    setAutoScroll(isAtBottom);
  }, [events.length, isRunning]);

  // 切换会话时重置状态
  useEffect(() => {
    prevCountRef.current = 0;
    setAutoScroll(true);
    setShowScrollBtn(false);
  }, [sessionId]);

  // 内容为空时隐藏滚动按钮
  useEffect(() => {
    if (events.length === 0 && !isRunning) {
      setShowScrollBtn(false);
      setAutoScroll(true);
      prevCountRef.current = 0;
    }
  }, [events.length, isRunning]);

  // 滚动到底部：历史加载用 instant，实时消息用 smooth
  useEffect(() => {
    if (!autoScroll) return;
    const prevCount = prevCountRef.current;
    const isHistoryLoad = prevCount === 0 && events.length > 1;
    const behavior: ScrollBehavior = isHistoryLoad ? 'instant' : 'smooth';
    prevCountRef.current = events.length;
    bottomRef.current?.scrollIntoView({ behavior });
  }, [events, autoScroll]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAutoScroll(true);
  };

  return (
    <div className="flex-1 relative overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-auto px-5 py-6 scroll-smooth"
      >
        <div className="max-w-3xl mx-auto space-y-5">
          {events.length === 0 && !isRunning && (
            <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[hsl(var(--primary)/0.12)] to-[hsl(var(--primary)/0.03)] flex items-center justify-center mb-4 border border-[hsl(var(--primary)/0.1)]">
                <Sparkles className="h-5 w-5 text-[hsl(var(--primary)/0.5)]" />
              </div>
              <p className="text-sm text-foreground/70 leading-relaxed max-w-[240px]">
                输入任务描述，让 Claude Agent<br />自主完成编码工作
              </p>
            </div>
          )}
          {events.map((msg, i) => (
            <AgentEventItem key={i} msg={msg} />
          ))}
          {isRunning && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground/60 py-2 animate-fade-in">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--primary)/0.8)]" />
              <span>Agent 执行中...</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll to bottom button */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-2 pointer-events-none">
        <button
          onClick={scrollToBottom}
          className={`
            pointer-events-auto
            h-9 w-9 rounded-full
            bg-background border border-border shadow-md
            flex items-center justify-center
            text-foreground/60 hover:text-foreground hover:shadow-lg
            transition-all duration-200
            ${showScrollBtn ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}
          `}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
