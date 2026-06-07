import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateCost } from '../../lib/pricing';
import type { Provider } from '../../types/provider';
import { ThinkingBlock, StreamingThinkingBlock } from './ThinkingBlock';

/** Isolated streaming content — subscribes to streaming state directly
 *  so rapid delta updates don't re-render the entire message list. */
function StreamingContent({ sessionId }: { sessionId: string }) {
  const stopped = useAgentStore((s) => s.forceStopped[sessionId] ?? false);
  const thinking = useAgentStore((s) => s.streamingThinking[sessionId] ?? '');
  const text = useAgentStore((s) => s.streamingText[sessionId] ?? '');
  if (stopped || (!thinking && !text)) return null;
  return (
    <>
      {thinking && <StreamingThinkingBlock thinking={thinking} />}
      {text && (
        <div className="animate-fade-in">
          <MarkdownRenderer content={text} />
          <span className="inline-block w-0.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom rounded-full" />
        </div>
      )}
    </>
  );
}
import { ToolCallCard } from './ToolCallCard';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Loader2, Sparkles, ArrowDown, Copy, Check } from 'lucide-react';
import { usePreviewStore } from '../../stores/previewStore';

interface AgentMessageListProps {
  sessionId: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Self-contained elapsed timer — manages its own interval to avoid re-rendering the parent. */
function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(timer);
  }, []);
  return <span>Agent 执行中 · {formatElapsed(elapsed)}</span>;
}

function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function AgentEventItem({ sessionId, msg, prevMsg, resultMap, provider, onFileClick, toolDurations, thinkingDurations, eventIndex, timestamp, assistantTextMap, events }: { sessionId: string; msg: AgentMessage; prevMsg?: AgentMessage; resultMap: Record<string, ToolResultEntry>; provider: Provider | null; onFileClick: (path: string, originalContent?: string) => void; toolDurations: Record<string, number>; thinkingDurations: Record<number, number>; eventIndex: number; timestamp?: number; assistantTextMap?: Record<number, { text: string; timestamp?: number }>; events: AgentMessage[] }) {
  try {
    return renderEvent(sessionId, msg, prevMsg, resultMap, provider, onFileClick, toolDurations, thinkingDurations, eventIndex, timestamp, assistantTextMap, events);
  } catch (err) {
    return (
      <div className="text-xs text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] rounded-xl p-3 my-1 border border-[hsl(var(--destructive)/0.12)]">
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
      className="inline-flex items-center text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
      title="复制"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function renderEvent(sessionId: string, msg: AgentMessage, _prevMsg: AgentMessage | undefined, resultMap: Record<string, ToolResultEntry>, provider: Provider | null, onFileClick: (path: string, originalContent?: string) => void, toolDurations: Record<string, number>, thinkingDurations: Record<number, number>, eventIndex: number, timestamp?: number, assistantTextMap?: Record<number, { text: string; timestamp?: number }>, events?: AgentMessage[]) {
  switch (msg.kind) {
    case 'user': {
      const content = msg.data.content;
      if (content === '[Request interrupted by user for tool use]') {
        return (
          <div className="text-xs text-muted-foreground/40 py-2 px-1 animate-fade-in">
            工具运行中断
          </div>
        );
      }
      return (
        <div className="flex flex-col items-end animate-fade-in-up">
          <div className="max-w-[80%] bg-gradient-to-br from-[hsl(var(--primary)/0.1)] to-[hsl(var(--primary)/0.05)] text-foreground rounded-2xl rounded-tr-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-all border border-[hsl(var(--primary)/0.08)]">
            {content}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {timestamp != null && timestamp > 0 && (
              <span className="text-xs text-muted-foreground/30 tabular-nums"
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
      return null;

    case 'system':
      return null;

    case 'assistant': {
      const rawBlocks = msg.data.message?.content;
      const blocks = Array.isArray(rawBlocks) ? rawBlocks : typeof rawBlocks === 'string' ? [{ type: 'text', text: rawBlocks }] : [];
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
      return null;

    case 'ask_user_question': {
      const resultEntry = resultMap[msg.data.tool_use_id];
      return (
        <AskUserQuestionCard
          sessionId={sessionId}
          toolUseId={msg.data.tool_use_id}
          questions={msg.data.questions}
          submitted={!!resultEntry}
          resultContent={resultEntry?.content}
        />
      );
    }

    case 'result': {
      if (events) {
        for (let i = eventIndex - 1; i >= 0; i--) {
          if (events[i].kind === 'compact') return null;
          if (events[i].kind === 'result') break;
        }
      }
      const cost = calculateCost(msg.data.usage, provider);
      const assistantData = assistantTextMap?.[eventIndex];
      return (
        <div className="border-t border-border/15 pt-3 mt-4 animate-fade-in-up">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground/40"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {assistantData && <CopyButton content={assistantData.text} />}
            {assistantData?.timestamp != null && assistantData.timestamp > 0 && (
              <>
                <span className="tabular-nums">{formatTime(assistantData.timestamp)}</span>
                <span className="text-muted-foreground/20">·</span>
              </>
            )}
            <span>耗时 {(msg.data.duration_ms / 1000).toFixed(1)}s</span>
            <span className="text-muted-foreground/20">·</span>
            <span>轮次 {msg.data.num_turns}</span>
            {cost != null && (
              <>
                <span className="text-muted-foreground/20">·</span>
                <span>${cost.toFixed(4)}</span>
              </>
            )}
            <span className="text-muted-foreground/20">·</span>
            <span>{(msg.data.usage?.input_tokens || 0) + (msg.data.usage?.cache_read_input_tokens || 0) + (msg.data.usage?.cache_creation_input_tokens || 0)}+{msg.data.usage?.output_tokens} token</span>
            {(() => {
              const totalInput = (msg.data.usage?.input_tokens || 0) + (msg.data.usage?.cache_read_input_tokens || 0) + (msg.data.usage?.cache_creation_input_tokens || 0);
              const cacheRead = msg.data.usage?.cache_read_input_tokens || 0;
              if (totalInput > 0 && cacheRead > 0) {
                return (
                  <>
                    <span className="text-muted-foreground/20">·</span>
                    <span>缓存命中 {((cacheRead / totalInput) * 100).toFixed(0)}%</span>
                  </>
                );
              }
              return null;
            })()}
          </div>
        </div>
      );
    }

    case 'error':
      return (
        <div className="text-sm text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] rounded-xl p-3 border border-[hsl(var(--destructive)/0.12)] animate-fade-in">
          错误: {msg.data.error}
        </div>
      );

    case 'api_retry': {
      const { attempt, max_retries, error_status, error } = msg.data;
      const isLastRetry = attempt >= max_retries;
      return (
        <div className={`text-xs rounded-xl p-3 my-1 border animate-fade-in ${
          isLastRetry
            ? 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]'
            : 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.06)] border-[hsl(var(--warning)/0.12)]'
        }`}>
          {isLastRetry ? '请求失败' : `请求重试 ${attempt}/${max_retries}`} · {error_status}: {error}
        </div>
      );
    }

    case 'compact': {
      const preTokens = msg.data.compact_metadata?.pre_tokens;
      const tokenText = preTokens ? ` · 节省 ${formatTokenCount(preTokens)} tokens` : '';
      return (
        <div className="text-center py-3">
          <span className="text-[11px] text-muted-foreground/35 tracking-wider font-medium">
            — 上下文已压缩{tokenText} —
          </span>
        </div>
      );
    }

    case 'done':
      return null;

    case 'raw':
      if (msg.data.type === 'sidecar_debug' || msg.data.type === 'system') {
        return null;
      }
      return (
        <details className="text-xs text-muted-foreground/35 group">
          <summary className="cursor-pointer hover:text-muted-foreground/60 transition-colors">
            原始事件: {String(msg.data.type)}
          </summary>
          <pre className="mt-1.5 bg-muted/20 rounded-xl p-3 overflow-auto max-h-32 border border-border/10"
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

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container || userIdxes.length === 0) return;

    const updateActive = () => {
      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top + 40;

      let closest = -1;
      let minDist = Infinity;

      for (const idx of userIdxes) {
        const el = document.getElementById(`msg-${idx}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const dist = rect.top - containerTop;
        if (dist >= -20 && dist < minDist) {
          minDist = dist;
          closest = idx;
        }
      }

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
      const offset = 22;
      container.scrollTo({ top: container.scrollTop + (elTop - containerTop) - offset, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

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
                  ? 'bg-[hsl(var(--primary))] scale-125'
                  : 'bg-muted-foreground/20 hover:bg-muted-foreground/40'
                }
              `}
            />
            {hoveredBar === idx && (
              <div className="
                absolute right-full top-1/2 -translate-y-1/2 mr-2
                max-w-[220px] px-3 py-1.5 rounded-lg
                bg-[hsl(var(--popover))] border border-border/30 shadow-lg
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
  const prevCountRef = useRef(0);
  const prevUserMsgCount = useRef(0);
  const openFile = usePreviewStore((s) => s.openFile);
  const handleFileClick = useCallback(
    (path: string, originalContent?: string) => {
      openFile(path, originalContent);
    },
    [openFile]
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasContent = events.length > 0 || isRunning;
    if (!hasContent) {
      setShowScrollBtn(false);
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const hasOverflow = el.scrollHeight > el.clientHeight;
    setShowScrollBtn(hasOverflow && distanceFromBottom > 200);
  }, [events.length, isRunning]);

  const [contentVisible, setContentVisible] = useState(true);

  useEffect(() => {
    prevCountRef.current = 0;
    prevUserMsgCount.current = 0;
    prevEventCount.current = 0;
    setShowScrollBtn(false);
    setContentVisible(false);
  }, [sessionId]);

  const prevEventCount = useRef(0);
  useEffect(() => {
    if (prevEventCount.current === 0 && events.length > 0) {
      prevUserMsgCount.current = events.filter(e => e.kind === 'user').length;
      prevEventCount.current = events.length;
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        setContentVisible(true);
      });
      return;
    }
    prevEventCount.current = events.length;
  }, [events.length]);

  useEffect(() => {
    if (events.length === 0 && !isRunning) {
      setShowScrollBtn(false);
      prevCountRef.current = 0;
    }
  }, [events.length, isRunning]);

  const toolDurations = useMemo(() => buildToolDurationMap(events, eventTimestamps), [events, eventTimestamps]);
  const thinkingDurations = useMemo(() => buildThinkingDurationMap(events, eventTimestamps), [events, eventTimestamps]);
  const assistantTextMap = useMemo(() => buildAssistantTextMap(events, eventTimestamps), [events, eventTimestamps]);

  const userIdxes = useMemo(
    () => events.reduce<number[]>((acc, msg, i) => {
      if (msg.kind === 'user' && msg.data.content !== '[Request interrupted by user for tool use]') acc.push(i);
      return acc;
    }, []),
    [events]
  );

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const userMsgCount = useMemo(() => events.filter(e => e.kind === 'user').length, [events]);
  useEffect(() => {
    if (userMsgCount > prevUserMsgCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevUserMsgCount.current = userMsgCount;
  }, [userMsgCount]);

  return (
    <div className="flex-1 relative overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-auto px-5 py-6"
        style={{ visibility: contentVisible ? 'visible' : 'hidden' }}
      >
        <div className="max-w-3xl mx-auto space-y-5">
          {events.length === 0 && !isRunning && (
            <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[hsl(var(--primary)/0.1)] to-[hsl(var(--primary)/0.03)] flex items-center justify-center mb-5 border border-[hsl(var(--primary)/0.08)] shadow-[0_0_20px_hsl(var(--primary)/0.06)]">
                <Sparkles className="h-6 w-6 text-[hsl(var(--primary)/0.4)]" />
              </div>
              <p className="text-sm text-foreground/50 leading-relaxed max-w-[260px]">
                输入任务描述，让 Claude Agent<br />自主完成编码工作
              </p>
            </div>
          )}
          {events.map((msg, i) => (
            <div key={i} id={msg.kind === 'user' ? `msg-${i}` : undefined}>
              <AgentEventItem sessionId={sessionId} msg={msg} prevMsg={i > 0 ? events[i - 1] : undefined} resultMap={resultMap} provider={provider} onFileClick={handleFileClick} toolDurations={toolDurations} thinkingDurations={thinkingDurations} eventIndex={i} timestamp={eventTimestamps[i]} assistantTextMap={assistantTextMap} events={events} />
            </div>
          ))}
          {/* Streaming content — isolated component to avoid re-rendering the entire list */}
          <StreamingContent sessionId={sessionId} />
          {isRunning && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground/40 py-2 animate-fade-in">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--primary)/0.6)]" />
              <ElapsedTimer />
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
            bg-[hsl(var(--card))] border border-border/30 shadow-[0_2px_10px_-2px_hsl(var(--foreground)/0.08)]
            flex items-center justify-center
            text-foreground/50 hover:text-foreground hover:shadow-[0_4px_16px_-2px_hsl(var(--foreground)/0.12)]
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
