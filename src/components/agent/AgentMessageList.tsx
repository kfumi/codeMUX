import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateCost } from '../../lib/pricing';
import type { Provider } from '../../types/provider';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Loader2, Sparkles, ArrowDown, Copy, Check } from 'lucide-react';
import { usePreviewStore } from '../../stores/previewStore';

interface AgentMessageListProps {
  sessionId: string;
}

function AgentEventItem({ msg, resultMap, provider, onFileClick, toolDurations, thinkingDurations, eventIndex, timestamp, assistantTextMap }: { msg: AgentMessage; resultMap: Record<string, ToolResultEntry>; provider: Provider | null; onFileClick: (path: string, originalContent?: string) => void; toolDurations: Record<string, number>; thinkingDurations: Record<number, number>; eventIndex: number; timestamp?: number; assistantTextMap?: Record<number, { text: string; timestamp?: number }> }) {
  try {
    return renderEvent(msg, resultMap, provider, onFileClick, toolDurations, thinkingDurations, eventIndex, timestamp, assistantTextMap);
  } catch (err) {
    return (
      <div className="text-xs text-red-500 bg-red-500/[0.06] rounded-xl p-3 my-1 border border-red-500/15">
        渲染错误: {String(err)}
        <pre className="mt-1 text-[10px] opacity-50">{JSON.stringify(msg, null, 2).slice(0, 200)}</pre>
      </div>
    );
  }
}

interface ToolResultEntry {
  content: string;
  isError: boolean;
}

function buildResultMap(events: AgentMessage[]): Record<string, ToolResultEntry> {
  const map: Record<string, ToolResultEntry> = {};
  for (const evt of events) {
    if (evt.kind !== 'tool_result') continue;
    const rawContent: any = evt.data?.message?.content;
    if (Array.isArray(rawContent)) {
      for (const r of rawContent) {
        if (r?.type === 'tool_result' && r.tool_use_id) {
          const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
          map[r.tool_use_id] = { content, isError: !!r.is_error };
        }
      }
    }
  }
  return map;
}

/** Map each event index to the nearest preceding assistant's text content and timestamp */
function buildAssistantTextMap(
  events: AgentMessage[],
  eventTimestamps: number[],
): Record<number, { text: string; timestamp?: number }> {
  const map: Record<number, { text: string; timestamp?: number }> = {};
  let lastAssistant: { text: string; timestamp?: number } | null = null;

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];
      const text = blocks
        .filter((b: any) => b?.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('\n\n');
      if (text) {
        lastAssistant = { text, timestamp: eventTimestamps[i] };
      }
    }
    if (evt.kind === 'result' && lastAssistant) {
      map[i] = lastAssistant;
    }
  }

  return map;
}

/** Extract tool call durations: prefer SDK tool_progress events, fallback to frontend timestamps */
function buildToolDurationMap(events: AgentMessage[], eventTimestamps: number[]): Record<string, number> {
  const durations: Record<string, number> = {};

  // 1. Frontend timestamps for all tools (tool_use -> tool_result)
  const startTimes: Record<string, number> = {};
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    const ts = eventTimestamps[i];
    if (!ts) continue;

    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block.id && !startTimes[block.id]) {
          startTimes[block.id] = ts;
        }
      }
    }

    if (evt.kind === 'tool_result') {
      const data: any = evt.data;
      const rawContent = data?.message?.content;
      if (Array.isArray(rawContent)) {
        for (const r of rawContent) {
          if (r?.type === 'tool_result' && r.tool_use_id && startTimes[r.tool_use_id]) {
            durations[r.tool_use_id] = ts - startTimes[r.tool_use_id];
          }
        }
      }
      if (data?.tool_use_result?.tool_use_id && startTimes[data.tool_use_result.tool_use_id]) {
        durations[data.tool_use_result.tool_use_id] = ts - startTimes[data.tool_use_result.tool_use_id];
      }
      if (data?.parent_tool_use_id && startTimes[data.parent_tool_use_id] && !durations[data.parent_tool_use_id]) {
        durations[data.parent_tool_use_id] = ts - startTimes[data.parent_tool_use_id];
      }
    }
  }

  // 2. SDK tool_progress events (override frontend timestamps)
  for (const evt of events) {
    if (evt.kind !== 'raw') continue;
    const data = evt.data;
    if (data.type !== 'tool_progress') continue;
    const toolUseId = data.tool_use_id;
    const elapsed = data.elapsed_time_seconds;
    if (typeof toolUseId === 'string' && typeof elapsed === 'number') {
      durations[toolUseId] = Math.round(elapsed * 1000);
    }
  }

  // 3. SDK task_notification events (override for Agent tools)
  for (const evt of events) {
    if (evt.kind !== 'raw' && evt.kind !== 'system') continue;
    const data: any = evt.data;
    if (data?.type !== 'system' || data?.subtype !== 'task_notification') continue;
    const toolUseId = data.tool_use_id;
    const durationMs = data?.usage?.duration_ms;
    if (typeof toolUseId === 'string' && typeof durationMs === 'number' && durationMs > 0) {
      durations[toolUseId] = durationMs;
    }
  }

  return durations;
}

/** Compute thinking block durations: time from assistant message with thinking to the next event */
function buildThinkingDurationMap(
  events: AgentMessage[],
  eventTimestamps: number[],
): Record<number, number> {
  const durations: Record<number, number> = {};

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.kind !== 'assistant') continue;
    const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];
    const hasThinking = blocks.some((b: any) => b?.type === 'thinking' && b.thinking);
    if (!hasThinking) continue;

    const startTs = eventTimestamps[i];
    // Find the next event with a valid timestamp
    for (let j = i + 1; j < events.length; j++) {
      if (eventTimestamps[j]) {
        durations[i] = eventTimestamps[j] - startTs;
        break;
      }
    }
  }

  return durations;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const time = `${h}:${m}`;

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(d, now)) {
    return time;
  }
  if (isSameDay(d, yesterday)) {
    return `昨天 ${time}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${month}-${day} ${time}`;
  }
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day} ${time}`;
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
      title="复制"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function renderEvent(msg: AgentMessage, resultMap: Record<string, ToolResultEntry>, provider: Provider | null, onFileClick: (path: string, originalContent?: string) => void, toolDurations: Record<string, number>, thinkingDurations: Record<number, number>, eventIndex: number, timestamp?: number, assistantTextMap?: Record<number, { text: string; timestamp?: number }>) {
  switch (msg.kind) {
    case 'user': {
      const content = msg.data.content;
      if (content === '[Request interrupted by user for tool use]') {
        return (
          <div className="text-xs text-muted-foreground/50 py-2 px-1 animate-fade-in">
            工具运行中断
          </div>
        );
      }
      return (
        <div className="flex flex-col items-end animate-fade-in-up">
          <div className="max-w-[80%] bg-primary/10 text-foreground rounded-2xl rounded-tr-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
            {content}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {timestamp != null && timestamp > 0 && (
              <span className="text-xs text-muted-foreground/40 tabular-nums"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {formatTime(timestamp)}
              </span>
            )}
            <CopyButton content={content} />
          </div>
        </div>
      );
    }

    case 'ready':
      return (
        <div className="text-xs text-muted-foreground/60 py-2 px-1 animate-fade-in">
          Agent 已就绪
        </div>
      );

    case 'system': {
      const model = msg.data.model;
      const tools = Array.isArray(msg.data.tools) ? msg.data.tools : [];
      // Skip rendering if the init message has no useful data
      if (!model && tools.length === 0) return null;
      return (
        <div className="text-xs text-muted-foreground py-2 px-1 border-b border-border/20 mb-4 animate-fade-in"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          会话初始化 · 模型: {model || '未知'} · 工具: {tools.length} 个
        </div>
      );
    }

    case 'assistant': {
      const rawBlocks = msg.data.message?.content;
      const blocks = Array.isArray(rawBlocks) ? rawBlocks : typeof rawBlocks === 'string' ? [{ type: 'text', text: rawBlocks }] : [];
      // Filter out "No response requested." — useless message from interrupted queries
      const filteredBlocks = blocks.filter((b: any) =>
        !(b?.type === 'text' && b.text?.trim() === 'No response requested.')
      );
      if (filteredBlocks.length === 0) return null;
      return (
        <div className="space-y-3 animate-fade-in-up">
          {filteredBlocks.map((block: any, i: number) => {
            if (block?.type === 'thinking' && block.thinking) {
              return <ThinkingBlock key={i} thinking={block.thinking} durationMs={thinkingDurations[eventIndex]} />;
            }
            if (block?.type === 'text' && block.text) {
              return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none leading-[1.7]">
                  <MarkdownRenderer content={block.text} />
                </div>
              );
            }
            if (block?.type === 'tool_use' && block.name) {
              const entry = block.id ? resultMap[block.id] : undefined;
              const status = !entry ? 'pending' as const
                : entry.isError ? 'error' as const
                : 'done' as const;
              return (
                <ToolCallCard
                  key={i}
                  toolName={block.name}
                  input={block.input || {}}
                  result={entry?.content}
                  status={status}
                  durationMs={block.id ? toolDurations[block.id] : undefined}
                  onFileClick={onFileClick}
                />
              );
            }
            return null;
          })}
        </div>
      );
    }

    case 'tool_result':
      // 已在 assistant 的 tool_use 中内联展示，跳过
      return null;

    case 'ask_user_question': {
      const resultEntry = resultMap[msg.data.tool_use_id];
      return (
        <AskUserQuestionCard
          toolUseId={msg.data.tool_use_id}
          questions={msg.data.questions}
          submitted={!!resultEntry}
          resultContent={resultEntry?.content}
        />
      );
    }

    case 'result': {
      const cost = calculateCost(msg.data.usage, provider);
      const assistantData = assistantTextMap?.[eventIndex];
      return (
        <div className="border-t border-border/20 pt-3 mt-4 animate-fade-in-up">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/60"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {assistantData && <CopyButton content={assistantData.text} />}
            {assistantData?.timestamp != null && assistantData.timestamp > 0 && (
              <>
                <span className="tabular-nums">{formatTime(assistantData.timestamp)}</span>
                <span className="text-muted-foreground/30">|</span>
              </>
            )}
            <span>耗时 {(msg.data.duration_ms / 1000).toFixed(1)}s</span>
            <span className="text-muted-foreground/30">|</span>
            <span>轮次 {msg.data.num_turns}</span>
            {cost != null && (
              <>
                <span className="text-muted-foreground/30">|</span>
                <span>${cost.toFixed(4)}</span>
              </>
            )}
            <span className="text-muted-foreground/30">|</span>
            <span>{msg.data.usage?.input_tokens}+{msg.data.usage?.output_tokens} token</span>
          </div>
        </div>
      );
    }

    case 'error':
      return (
        <div className="text-sm text-red-500 bg-red-500/[0.06] rounded-xl p-3 border border-red-500/15 animate-fade-in">
          错误: {msg.data.error}
        </div>
      );

    case 'api_retry': {
      const { attempt, max_retries, error_status, error } = msg.data;
      const isLastRetry = attempt >= max_retries;
      return (
        <div className={`text-xs rounded-xl p-3 my-1 border animate-fade-in ${
          isLastRetry
            ? 'text-red-500 bg-red-500/[0.06] border-red-500/15'
            : 'text-amber-500 bg-amber-500/[0.06] border-amber-500/15'
        }`}>
          {isLastRetry ? '请求失败' : `请求重试 ${attempt}/${max_retries}`} · {error_status}: {error}
        </div>
      );
    }

    case 'done':
      return null;

    case 'raw':
      // 隐藏 sidecar 调试信息和 SDK 内部系统消息，不在对话中展示
      if (msg.data.type === 'sidecar_debug' || msg.data.type === 'system') {
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
const EMPTY_TIMESTAMPS: number[] = [];

// 消息导航组件 - 右侧短杠导航
function MessageNav({
  userIdxes,
  messages,
  scrollContainer,
}: {
  userIdxes: number[];
  messages: AgentMessage[];
  scrollContainer: React.RefObject<HTMLDivElement | null>;
}) {
  const [hovered, setHovered] = useState(false);
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  // 监听滚动，计算当前可视区域顶部附近的用户消息
  useEffect(() => {
    const container = scrollContainer.current;
    if (!container || userIdxes.length === 0) return;

    const updateActive = () => {
      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top + 40; // 留一点顶部边距

      let closest = -1;
      let minDist = Infinity;

      for (const idx of userIdxes) {
        const el = document.getElementById(`msg-${idx}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const dist = rect.top - containerTop;
        // 找到距离顶部最近且在可视区域内的消息
        if (dist >= -20 && dist < minDist) {
          minDist = dist;
          closest = idx;
        }
      }

      // 如果没有找到，在顶部上方的消息中找最近的
      if (closest === -1) {
        for (const idx of userIdxes) {
          const el = document.getElementById(`msg-${idx}`);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const dist = Math.abs(rect.top - containerTop);
          if (dist < minDist) {
            minDist = dist;
            closest = idx;
          }
        }
      }

      setActiveIdx(closest);
    };

    updateActive();
    container.addEventListener('scroll', updateActive, { passive: true });
    return () => container.removeEventListener('scroll', updateActive);
  }, [userIdxes, scrollContainer]);

  const handleClick = (idx: number) => {
    const el = document.getElementById(`msg-${idx}`);
    if (!el) return;
    const container = scrollContainer.current;
    if (container) {
      const containerTop = container.getBoundingClientRect().top;
      const elTop = el.getBoundingClientRect().top;
      const offset = 22; // 消息顶部留出间距
      container.scrollTo({ top: container.scrollTop + (elTop - containerTop) - offset, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // 截取消息预览文本
  const getPreview = (msg: AgentMessage): string => {
    if (msg.kind === 'user') {
      const text = msg.data.content;
      return text.length > 20 ? text.slice(0, 20) + '...' : text;
    }
    return '';
  };

  if (userIdxes.length <= 1) return null;

  return (
    <div
      className="absolute right-2 top-0 bottom-0 w-8 flex items-center justify-center z-10"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setHoveredBar(null); }}
    >
      <div
        className={`
          flex flex-col items-center gap-2.5 py-4
          transition-opacity duration-200
          ${hovered ? 'opacity-100' : 'opacity-0'}
        `}
      >
        {userIdxes.map((idx) => (
          <div key={idx} className="relative group">
            <button
              onMouseEnter={() => setHoveredBar(idx)}
              onMouseLeave={() => setHoveredBar(null)}
              onClick={() => handleClick(idx)}
              className={`
                w-4 h-1.5 rounded-full transition-all duration-150
                ${idx === activeIdx
                  ? 'bg-primary scale-125'
                  : 'bg-muted-foreground/25 hover:bg-muted-foreground/50'
                }
              `}
            />
            {/* 消息预览气泡 */}
            {hoveredBar === idx && (
              <div className="
                absolute right-full top-1/2 -translate-y-1/2 mr-2
                max-w-[220px] px-3 py-1.5 rounded-lg
                bg-popover border border-border shadow-lg
                text-xs text-popover-foreground whitespace-nowrap overflow-hidden text-ellipsis
                animate-fade-in pointer-events-none
              ">
                {getPreview(messages[idx])}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentMessageList({ sessionId }: AgentMessageListProps) {
  const events = useAgentStore((s) => s.events[sessionId] ?? EMPTY_EVENTS);
  const eventTimestamps = useAgentStore((s) => s.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] ?? false);
  const config = useSettingsStore((s) => s.config);
  const provider = config?.providers.find((p) => p.id === config.active_provider_id) ?? null;
  const resultMap = useMemo(() => buildResultMap(events), [events]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 用户主动点击回到底部后，恢复自动滚动
  const [autoScroll, setAutoScroll] = useState(true);
  // 跟踪上一次事件数量，用于区分历史加载和实时消息
  const prevCountRef = useRef(0);
  const openFile = usePreviewStore((s) => s.openFile);
  const handleFileClick = useCallback(
    (path: string, originalContent?: string) => {
      openFile(path, originalContent);
    },
    [openFile]
  );

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

  // 计算工具调用和思考过程的执行时长
  const toolDurations = useMemo(() => buildToolDurationMap(events, eventTimestamps), [events, eventTimestamps]);
  const thinkingDurations = useMemo(() => buildThinkingDurationMap(events, eventTimestamps), [events, eventTimestamps]);
  const assistantTextMap = useMemo(() => buildAssistantTextMap(events, eventTimestamps), [events, eventTimestamps]);

  // 提取用户消息的事件索引，用于右侧导航（排除中断消息）
  const userIdxes = useMemo(
    () => events.reduce<number[]>((acc, msg, i) => {
      if (msg.kind === 'user' && msg.data.content !== '[Request interrupted by user for tool use]') acc.push(i);
      return acc;
    }, []),
    [events]
  );

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
            <div key={i} id={msg.kind === 'user' ? `msg-${i}` : undefined}>
              <AgentEventItem msg={msg} resultMap={resultMap} provider={provider} onFileClick={handleFileClick} toolDurations={toolDurations} thinkingDurations={thinkingDurations} eventIndex={i} timestamp={eventTimestamps[i]} assistantTextMap={assistantTextMap} />
            </div>
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

      {/* 消息导航 - 右侧短杠 */}
      <MessageNav userIdxes={userIdxes} messages={events} scrollContainer={scrollRef} />

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
