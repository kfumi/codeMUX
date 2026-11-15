import { Brain, ChevronRight, Sparkles } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import { useAgentStore, type AgentMessage } from '@/stores/agentStore';
import { resolveLiveStreamContent } from '@/components/agent/assistant-ui/liveStreamContent';
import { thinkingTailLine } from '@/lib/activityRuns';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';

/**
 * 过程步骤的展示件：思考行压缩成「思考 + 单行摘要」，展开后是这段思考的 Markdown 正文。
 * 过程组（Activity Run）的组头也在本文件：段首一行轻量组头，展开后步骤缩进。
 */

/**
 * 过程组展开后步骤行的缩进：与组头图标左缘对齐的旧节奏（组头自带 5px 内边距 + 15px 图标）。
 * 主线程与子智能体时间线共用同一个值，两边的步骤列才在同一条竖直线上。
 */
export const ACTIVITY_RUN_STEP_INDENT_CLASS = 'ml-[5px] pl-4 space-y-0.5 min-w-0';

const EMPTY_EVENTS: AgentMessage[] = [];

/**
 * 思考步骤的单行摘要：取**开头**那一段（对齐参考实现的 ThinkingRow——它把整段思考压成
 * 单行后由 CSS 截断，读者看到的是思考的起点）。
 */
export function thinkingSummaryLine(text: string): string {
  return text
    // 去掉行首的 Markdown 标题标记与强调标记，保留文字本身。
    .replace(/^#+\s*|\*\*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 流式摘要只需要尾部一小段参与归一化：摘要压成单行，流式时还会横向跟随尾部。
 * 否则实时思考每 50ms 一次 flush，都要对整段积累文本跑两遍全文正则。
 */
const SUMMARY_SOURCE_MAX_CHARS = 2_048;

/**
 * 思考步骤行。行壳与工具行同形（图标 + 动作词 + 摘要 + 箭头），展开后是这段思考的
 * Markdown；`data-slot="reasoning-trigger*"` 与既有断言、既有测试保持同名。
 * 动作词与摘要放在同一个按**基线**对齐的内层（两截字号不同、ascent/descent 比例也不同，
 * 纯几何居中会让摘要偏高约 1px）；行本身仍整体居中，图标与箭头的位置因此不变。
 * 展开后的思考正文按全局 UI 字号渲染（正文跟设置走），只有动作词与单行摘要比正文小一号。
 * 流式期间默认收起，摘要逐字揭示并在超出单行宽度时跟随最新文字；用户展开后摘要隐藏，
 * 正文在面板里继续流式展示。流结束时自动收起，之后用户仍可手动展开查看完整内容。
 */
export function ActivityStepThinking({
  text,
  streaming = false,
  previewText,
  body,
}: {
  text: string;
  streaming?: boolean;
  /** 实时摘要使用与正文一致的逐帧揭示文本。 */
  previewText?: string;
  /** 自定义正文：实时思考用它渲染被节流揭示的纯文本切片，不重新解析 Markdown。 */
  body?: ReactNode;
}) {
  const detailsId = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const previousStreamingRef = useRef(streaming);
  const summaryViewportRef = useRef<HTMLSpanElement>(null);
  const open = userOpen ?? false;
  const isNarrow = useIsNarrowViewport();
  // 展开时摘要不渲染，也就不必计算（实时思考现在保留全文，全文正则不再免费）。
  const summarySource = streaming
    ? (previewText ?? text).slice(-SUMMARY_SOURCE_MAX_CHARS)
    : text;
  const summary = open ? '' : thinkingSummaryLine(summarySource);

  // 流开始或结束都重置当前展开选择：新思考默认收起，正在查看的实时思考结束后也收起。
  // useLayoutEffect 在浏览器绘制前同步关闭面板，避免结束瞬间闪出已完成的展开内容。
  useLayoutEffect(() => {
    if (previousStreamingRef.current === streaming) return;
    previousStreamingRef.current = streaming;
    setUserOpen(null);
  }, [streaming]);

  // 实时摘要保持单行；文字超出可视区域时横向跟随尾部，完成后回到摘要开头。
  useLayoutEffect(() => {
    const viewport = summaryViewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = streaming && !open ? viewport.scrollWidth : 0;
  }, [summary, streaming, open]);

  return (
    <div data-slot="activity-step" data-step-kind="thinking" className="tool-row thinking min-w-0">
      <button
        type="button"
        data-slot="reasoning-trigger"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={open ? '收起思考内容' : '展开思考内容'}
        onClick={() => setUserOpen(!open)}
        className={cn(
          'group/trigger -mx-1 inline-flex min-h-6 max-w-full items-center gap-1 rounded-sm px-1',
          'text-start text-ui-compact text-muted-foreground transition-colors',
          'hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground',
        )}
      >
        <span
          data-slot="reasoning-trigger-icon"
          className="inline-flex size-[1.08em] shrink-0 items-center justify-center text-muted-foreground -translate-y-[0.035em]"
        >
          <Brain aria-hidden className="size-full" />
        </span>
        <span
          data-slot="reasoning-trigger-label"
          className={cn(
            'relative inline-flex min-w-0 items-baseline font-medium',
            streaming && 'text-muted-foreground',
          )}
        >
          {/* 动作词不能被摘要挤到换行：它不参与收缩，长摘要在它右边截断。 */}
          <span className="shrink-0 whitespace-nowrap">思考</span>
          {streaming ? (
            <span
              data-slot="reasoning-trigger-pulse"
              aria-hidden
              className="ml-[6px] inline-block size-1 shrink-0 self-center animate-pulse rounded-full bg-current motion-reduce:animate-none"
            />
          ) : null}
          {summary && !open ? (
            <span
              ref={summaryViewportRef}
              data-slot="reasoning-trigger-summary"
              className="ml-1 min-w-0 max-w-full overflow-hidden whitespace-nowrap text-ui-meta font-normal text-muted-foreground"
            >
              {summary}
            </span>
          ) : null}
        </span>
        <ChevronRight
          data-slot="reasoning-trigger-chevron"
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 self-center',
            'transition-transform duration-normal ease-motion-standard motion-reduce:transition-none',
            isNarrow
              ? 'opacity-100'
              : 'opacity-0 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      </button>
      {open ? (
        <div
          id={detailsId}
          data-slot="activity-step-body"
          className="mt-0.5 pl-6 text-ui-body leading-relaxed text-muted-foreground"
        >
          {body ?? (
            <Streamdown mode="static" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>
              {text}
            </Streamdown>
          )}
        </div>
      ) : null}
    </div>
  );
}

export type ActivityRunGroupHeadProps = {
  /** 段内已提交的可见步骤数（实时思考的附加步骤由组头自己判定）。 */
  stepCount: number;
  /** 该段是否是运行中的尾段。 */
  live: boolean;
  open: boolean;
  onToggle: () => void;
  /** 完成态标题：动宾短句统计（`已探索 2 次，已执行 11 命令，已修改 1 文件` / `已思考 N 段`）。 */
  completedText: string;
  /** 实时态的活动工具摘要（未决调用，投影已按最新参数解析）；无未决调用时为空。 */
  activeToolSummary?: string;
  /** 实时态在无活动项时的兜底：段尾步骤单行摘要。 */
  fallbackTail: string;
  /** 主线程需要读实时缓冲；子智能体时间线自己算好摘要后可直接走完成态分支。 */
  sessionId?: string;
  /** 实时思考摘要的替代来源（子智能体：来自未提交尾部投影，不走 agentStore）。 */
  liveThinkingSummary?: string;
  liveThinkingPresent?: boolean;
  /** 受控步骤区的 id（段首行步骤缩进容器），供 aria-controls 关联。 */
  controlsId?: string;
};

/**
 * 过程组组头：段首承载唯一一行。完成态显示分类统计；实时态显示最近活动项摘要
 * （实时思考 → 未决工具 → 段尾步骤兜底），两个可见步骤起才有组头。
 *
 * 实时态拆成独立子组件：只有运行中的尾段组头会订阅实时缓冲（每条 flush 重渲染的
 * 只有这一个叶子），历史组的组头不吃任何流式订阅。
 */
export function ActivityRunGroupHead(props: ActivityRunGroupHeadProps) {
  if (!props.live) {
    if (props.stepCount < 2) {
      return null;
    }
    return (
      <ActivityRunHeader
        open={props.open}
        onToggle={props.onToggle}
        label={props.completedText}
        live={false}
        controlsId={props.controlsId}
      />
    );
  }
  return <LiveActivityRunGroupHead {...props} />;
}

function LiveActivityRunGroupHead(props: ActivityRunGroupHeadProps) {
  // 子智能体时间线没有 agentStore 实时缓冲：摘要由调用方算好传入。
  const buffered = useLiveStreamThinking(props.sessionId ?? '');
  const thinkingPresent = props.liveThinkingPresent ?? buffered.present;
  const thinkingSummary = props.liveThinkingSummary ?? buffered.summary;
  const effectiveCount = props.stepCount + (thinkingPresent ? 1 : 0);
  if (effectiveCount < 2) {
    // 还不满足成组门槛（比如只有一个已提交步骤、实时思考也还没来）：保持单行现状。
    return null;
  }
  const label = thinkingPresent && thinkingSummary
    ? thinkingSummary
    : props.activeToolSummary || props.fallbackTail;
  return (
    <ActivityRunHeader
      open={props.open}
      onToggle={props.onToggle}
      label={label}
      live
      controlsId={props.controlsId}
    />
  );
}

/**
 * 组头行壳：图标 + 单行文案 + chevron。
 * 完成态传分类统计，实时态传最近活动项摘要，两个可见步骤起才渲染。
 * 运行状态由实时摘要本身与「工作中」状态行表达，这里不画装饰动画
 * （动效公约：连续动画集中豁免，`prefers-reduced-motion` 全局处理）。
 */
export function ActivityRunHeader({
  open,
  onToggle,
  label,
  live,
  controlsId,
}: {
  open: boolean;
  onToggle: () => void;
  /** 单行文案：实时=最近活动项摘要，完成=分类统计。 */
  label: string;
  live: boolean;
  /** 受控步骤区的 id（段首行的步骤缩进容器），供 aria-controls 关联。 */
  controlsId?: string;
}) {
  const isNarrow = useIsNarrowViewport();

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        data-slot="activity-run-trigger"
        data-live={live ? 'true' : 'false'}
        aria-expanded={open}
        aria-label={label}
        {...(controlsId ? { 'aria-controls': controlsId } : {})}
        onClick={onToggle}
        className={cn(
          'group/trigger -mx-[3px] inline-flex min-h-[26px] max-w-full items-center gap-[5px] rounded-sm px-[5px]',
          'text-start text-ui-body text-muted-foreground transition-colors',
          'hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground',
        )}
      >
        <span
          data-slot="activity-run-icon"
          className="inline-flex size-[15px] shrink-0 items-center justify-center text-muted-foreground"
        >
          <Sparkles aria-hidden className="size-[15px]" />
        </span>
        {/* 图标居中、文字共基线（与思考步骤行同规则）：两截字号不同时按基线对齐。 */}
        <span
          data-slot="activity-run-text"
          className="inline-flex min-w-0 items-baseline gap-[5px]"
        >
          <span
            data-slot="activity-run-label"
            className="relative inline-flex min-w-0 items-baseline font-medium"
          >
            <span className="min-w-0 max-w-full truncate">{label}</span>
          </span>
        </span>
        <ChevronRight
          data-slot="activity-run-caret"
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 self-center',
            'transition-transform duration-normal ease-motion-standard',
            isNarrow
              ? 'opacity-100'
              : 'opacity-0 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      </button>
    </div>
  );
}

/** 主线程实时缓冲的窄订阅：只给运行中的尾段组头用（同屏最多一个实例）。 */
function useLiveStreamThinking(sessionId: string): { present: boolean; summary: string } {
  // 子智能体调用方不传 sessionId：不订阅主线程事件流。
  const events = useAgentStore((state) => (sessionId ? state.events[sessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS));
  const thinking = useAgentStore((state) => (sessionId ? state.streamingThinking[sessionId] ?? '' : ''));
  const text = useAgentStore((state) => (sessionId ? state.streamingText[sessionId] ?? '' : ''));
  const thinkingEpoch = useAgentStore((state) => (sessionId ? state.streamingThinkingStartEventCount[sessionId] ?? 0 : 0));
  const stopped = useAgentStore((state) => (sessionId ? state.forceStopped[sessionId] ?? false : false));

  return useMemo(() => {
    if (stopped) {
      return { present: false, summary: '' };
    }
    const { visibleThinking } = resolveLiveStreamContent(events, {
      thinking,
      text,
      thinkingEpoch,
      stopped,
    });
    if (!visibleThinking) {
      return { present: false, summary: '' };
    }
    // 实时摘要取思考的尾部一行：流式时跟随最新文字，语义与思考步骤行的实时预览一致。
    return { present: true, summary: thinkingTailLine(visibleThinking) };
  }, [events, thinking, text, thinkingEpoch, stopped]);
}
