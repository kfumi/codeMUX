import { Brain, ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';

/**
 * 过程步骤的展示件：思考行压缩成「思考 + 单行摘要」，展开后是这段思考的 Markdown 正文。
 * 处理段的分组头与步骤缩进已移除（整轮折叠由「已处理」开关负责），这里只有步骤行本身。
 */

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
 * 思考步骤行。行壳与工具行同形（图标 + 动作词 + 摘要 + 箭头），展开后是这段思考的
 * Markdown；`data-slot="reasoning-trigger*"` 与既有断言、既有测试保持同名。
 * 动作词与摘要放在同一个按**基线**对齐的内层（两截字号不同、ascent/descent 比例也不同，
 * 纯几何居中会让摘要偏高约 1px）；行本身仍整体居中，图标与箭头的位置因此不变。
 * 展开后的思考正文按全局 UI 字号渲染（正文跟设置走），只有动作词与单行摘要比正文小一号。
 * 流式期间（`streaming`）不画右侧单行摘要：这一行此时是展开的、正文就在下面，摘要跟着
 * 每个 delta 实时变长只会把动作词挤来挤去；思考结束、行自动收起后再一次性给出摘要。
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
  // 点过之后由用户接管。
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
          {/* 流式思考不在行内实时长摘要：这一行在流式期间是展开的（正文就在下面），
              右侧单行摘要会跟着每个 delta 变长、把动作词挤来挤去。等这段思考结束、
              行自动收起之后再一次性给出摘要。 */}
          {summary && !streaming ? (
            <span
              data-slot="reasoning-trigger-summary"
              className="ml-1 min-w-0 truncate text-ui-meta font-normal text-muted-foreground"
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
