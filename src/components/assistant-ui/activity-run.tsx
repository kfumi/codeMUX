import { Brain, ChevronRight, Sparkles } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import { formatElapsed } from '@/components/agent/assistant-ui/RunningElapsed';
import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';

/**
 * 「处理段」（activity run）的展示件：一段连续的思考/工具调用共用一个组头，
 * 段内按源码顺序平铺步骤行。
 *
 * 组头文案、步骤数、尾预览与计时都对齐参考实现（PI-Desktop 的 `ActivityGroup`）：
 * 运行中 `处理中 · 12s` / `思考中 · 12s`，结束后 `已处理 12s` / `已思考 12s`。
 */

export type ActivityRunLabelInput = {
  live: boolean;
  onlyThinking: boolean;
  /** 该段的最后一个步骤是仍在流式的思考。 */
  thinkingNow?: boolean;
  durationMs?: number;
};

/** 组头文案。纯函数，单测直接对齐这四种状态。 */
export function activityRunLabel(input: ActivityRunLabelInput): string {
  const time = input.durationMs != null ? formatElapsed(Math.max(0, input.durationMs)) : '';
  if (input.live) {
    const base = input.thinkingNow || input.onlyThinking ? '思考中' : '处理中';
    return time ? `${base} · ${time}` : base;
  }
  if (input.onlyThinking) {
    return time ? `已思考 ${time}` : '思考';
  }
  return time ? `已处理 ${time}` : '已处理';
}

/**
 * 思考步骤的单行摘要：取**开头**那一段（对齐参考实现的 ThinkingRow——它把整段思考压成
 * 单行后由 CSS 截断，读者看到的是思考的起点）。组头的实时尾预览取最后一行，见
 * `activityRuns.ts` 的 `thinkingTailLine`。
 */
export function thinkingSummaryLine(text: string): string {
  return text
    // 去掉行首的 Markdown 标题标记与强调标记，保留文字本身。
    .replace(/^#+\s*|\*\*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ActivityRunHeader({
  open,
  onToggle,
  live,
  onlyThinking,
  thinkingNow = false,
  durationMs,
  stepCount,
  tail,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  live: boolean;
  onlyThinking: boolean;
  thinkingNow?: boolean;
  durationMs?: number;
  stepCount: number;
  /** 收起且运行中时的一行实时预览。 */
  tail?: string;
  className?: string;
}) {
  const isNarrow = useIsNarrowViewport();
  const label = activityRunLabel({ live, onlyThinking, thinkingNow, durationMs });
  const showTail = !open && live && Boolean(tail);

  return (
    <div className={cn('w-full min-w-0', className)}>
      <button
        type="button"
        data-slot="activity-run-trigger"
        data-live={live ? 'true' : 'false'}
        aria-expanded={open}
        aria-label={label}
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
          <Sparkles aria-hidden size={15} />
        </span>
        <span
          data-slot="activity-run-label"
          className="relative inline-flex shrink-0 items-center font-medium"
        >
          {label}
          {live ? (
            <span
              data-slot="activity-run-pulse"
              aria-hidden
              className="ml-[6px] inline-block size-1 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
            />
          ) : null}
        </span>
        {stepCount > 1 ? (
          <span
            data-slot="activity-run-count"
            className="min-w-0 truncate text-ui-compact tabular-nums"
          >
            {stepCount} 个步骤
          </span>
        ) : null}
        <ChevronRight
          data-slot="activity-run-caret"
          aria-hidden
          className={cn(
            'size-3 shrink-0',
            'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
            isNarrow
              ? 'opacity-100'
              : 'opacity-0 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      </button>
      {showTail ? (
        <div
          data-slot="activity-run-preview"
          aria-hidden
          className="ml-[26px] max-w-[min(100%,var(--chat-prose-max-width,720px))] truncate text-ui-caption text-muted-foreground"
        >
          {tail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 思考步骤行。行壳与工具行同形（图标 + 动作词 + 等宽摘要 + 箭头），展开后是这段思考的
 * Markdown；`data-slot="reasoning-trigger*"` 与既有断言、既有测试保持同名。
 * 动作词与等宽摘要放在同一个按**基线**对齐的内层（两种字体的 ascent/descent 不同，
 * 纯几何居中会让摘要偏高约 1px）；行本身仍整体居中，图标与箭头的位置因此不变。
 * 展开后的思考正文按全局 UI 字号渲染（正文跟设置走），只有动作词与单行摘要比正文小一号。
 */
export function ActivityStepThinking({
  text,
  streaming = false,
  body,
}: {
  text: string;
  streaming?: boolean;
  /** 自定义正文：实时思考用它渲染被节流揭示的纯文本切片，不重新解析 Markdown。 */
  body?: ReactNode;
}) {
  const detailsId = useId();
  // 用户没点过就跟随 streaming（实时思考默认展开、思考一结束自动收起）；
  // 点过之后由用户接管，与处理段组头的 claimedRunKeys/expandedRunKeys 同规则。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? streaming;
  const isNarrow = useIsNarrowViewport();
  const summary = thinkingSummaryLine(text);

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
          className="inline-flex size-[15px] shrink-0 items-center justify-center text-muted-foreground"
        >
          <Brain aria-hidden size={15} />
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
          {summary ? (
            <span
              data-slot="reasoning-trigger-summary"
              className="ml-1 min-w-0 truncate font-mono text-ui-meta font-normal text-muted-foreground"
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
            'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
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

/**
 * 段内步骤行的缩进：组头在 0，步骤行整体右侧 20px（`pl-5`）。
 *
 * 竖线在 9.5px（组头图标中线），步骤图标左缘在 20px —— 缩进与竖线位置是两个独立的值，
 * 改缩进不会挪动竖线（竖线是绝对定位，靠 `-ml`/`px` 的几何关系算出来，与 `pl-*` 无关）。
 */
export const ACTIVITY_RUN_STEP_INDENT = 'pl-5';

/**
 * 段内步骤容器：统一的缩进 + 一条**对齐段组头图标中线**的竖线。
 *
 * 位置是量出来的：组头触发器 `-mx-[3px] px-[5px]`、图标 15px，所以图标中心落在行内容
 * 左缘 9.5px 处；容器自身的 `pl-5` 不影响绝对定位（`left` 相对容器的 padding box 左缘，
 * 也就是行内容左缘），因此 `left-[9px]` 的 1px 线中心正好是 9.5px。Chromium 实测：
 * 组头图标中心 9.5px、竖线中心 9.5px。
 */
export function ActivityRunSteps({
  children,
  className,
  /**
   * 同一个处理段在本行之后还有步骤：行距被压到与段内步距一致（主线程 3px），竖线再向下
   * 多探一个行距接上下一行的竖线。取 8px 是为了同时覆盖预览面板的 8px 行距：多探的部分
   * 只落在下一行左侧的缩进空白里，与它自己的竖线重合，看不出多画了。
   */
  extendsIntoGap = false,
  /**
   * 这一段在本行之前还有步骤（实时思考行跟在已提交的步骤行后面）：竖线向上多探一个行距
   * 接上上一行。多探的部分同样只落在上一行左侧的缩进空白里。
   */
  extendsUpward = false,
}: {
  children: ReactNode;
  className?: string;
  extendsIntoGap?: boolean;
  extendsUpward?: boolean;
}) {
  return (
    <div className={cn('relative flex flex-col gap-[3px]', ACTIVITY_RUN_STEP_INDENT, className)}>
      <span
        data-slot="activity-run-steps-rail"
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-[9px] w-px bg-muted-foreground/18',
          extendsUpward ? 'top-[-8px]' : 'top-0',
          extendsIntoGap ? 'bottom-[-8px]' : 'bottom-1',
        )}
      />
      {children}
    </div>
  );
}
