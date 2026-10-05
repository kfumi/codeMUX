"use client";

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircleIcon, ChevronDownIcon, XCircleIcon } from 'lucide-react';
import {
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { useCollapsibleScrollLock } from '@/hooks/useCollapsibleScrollLock';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { getToolActionLabel, getToolDisplayName } from '@/components/agent/toolHeaderSummary';
import { ToolActionIcon } from '@/components/assistant-ui/tool-action-icon';

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useCollapsibleScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) setUncontrolledOpen(open);
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn('aui-tool-fallback-root group/tool-fallback-root group/tool-row w-full', className)}
      style={{ '--animation-duration': `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

/**
 * 工具行：动作图标 + 动作词 + 等宽摘要（由调用方通过 `children` 传入）+ 行尾状态 + 箭头。
 * 动作词与状态分离，是因为一行里「在做什么」和「做完没有」是两件事——参考实现里
 * 状态靠行尾的 spinner / 失败文字表达，图标只说明动作类别，读一列工具行时可以按形状扫读。
 *
 * 垂直方向分两层：整行**几何居中**（`min-h-6` 的行内所有元素居中），文字区
 * （动作词 + 摘要 + 状态徽标）作为居中的一组，组内**按基线对齐**。徽标必须落在
 * 动作词的基线上，不能按几何居中——动作词是 UI 字体而摘要是等宽字体，两种字形
 * 的行高不同，按几何居中会让「失败」比左边描述高约 1px，肉眼就是没在一个水平上。
 * 整行**不能**改成 `items-baseline`：`min-h-6` 会把基线组顶到伸缩后行的首沿，
 * 文字整体比居中的图标高约 3px。
 */
function ToolFallbackTrigger({
  toolName,
  status,
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  /** 原始工具名。展示用的动作词与图标都由它推导。 */
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';
  const isError = status?.type === 'incomplete' && !isCancelled;
  // 窄屏没有 hover:展开箭头常显(触发按钮本身可点,但箭头指示不应隐形)。
  const isNarrow = useIsNarrowViewport();
  const label = getToolActionLabel(toolName, { running: isRunning });
  const displayName = getToolDisplayName(toolName);
  // 无障碍名带上原始展示名：动作词让一列工具行可扫读，但读者仍需要知道具体是哪个工具。
  const accessibleName = displayName && displayName !== label
    ? `${label} · ${displayName}`
    : label;

  const statusNode = isRunning ? (
    <span
      data-slot="tool-fallback-status"
      role="status"
      aria-live="polite"
      aria-label="运行中"
      className="size-[11px] shrink-0 self-center animate-spin rounded-full border-[1.5px] border-border border-t-muted-foreground motion-reduce:animate-none"
    />
  ) : isError ? (
    // 徽标刻意**不是** flex 容器：flex 容器的基线取自第一个 flex item，而 SVG 的
    // 基线在底边，`items-baseline` 会把图标顶到「失败」上方。普通行内 span 的基线
    // 就是它自己的文字基线，外层文字区的 `items-baseline` 才能把「失败」和动作词
    // 对齐；图标退回行内元素、用 `align-middle` 在文字上做视觉居中。
    <span
      data-slot="tool-fallback-status"
      role="status"
      aria-live="polite"
      className="shrink-0 text-ui-caption text-destructive"
    >
      <XCircleIcon className="mr-1 inline-block size-3 align-middle" aria-hidden />
      失败
    </span>
  ) : isCancelled ? (
    <span
      data-slot="tool-fallback-status"
      role="status"
      aria-live="polite"
      className="shrink-0 text-ui-caption text-muted-foreground"
    >
      已取消
    </span>
  ) : statusType === 'requires-action' ? (
    <span
      data-slot="tool-fallback-status"
      role="status"
      aria-live="polite"
      className="inline-flex shrink-0 items-center self-center text-[hsl(var(--warning))]"
    >
      <AlertCircleIcon className="size-3.5" aria-hidden />
    </span>
  ) : null;

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      aria-label={accessibleName}
      className={cn(
        'aui-tool-fallback-trigger group/trigger -mx-1 inline-flex min-h-6 max-w-full items-center gap-1 rounded-sm px-1 text-ui-compact font-normal text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground',
        className,
      )}
      {...props}
    >
      {/* 光学对齐：CJK 字形在行盒里偏上（雅黑 ascent ≫ descent，字形带中心比盒中心高
          ~0.75px@13px），图标按盒居中就会显得比右边的文字低；lucide 图形绘制中心又比自身
          盒子高 ~0.31px，净差 ~0.44px（复现页实测）。用 em 微调补偿，随界面字号缩放。 */}
      <ToolActionIcon toolName={toolName} className="text-muted-foreground -translate-y-[0.035em]" />
      {/* 文字区（动作词 + 摘要 + 状态徽标）整体在 24px 行里居中，内部按基线对齐。
          整行不能用 `items-baseline`：`min-h-6` 会把基线组顶到伸缩后的行首沿，
          文字整体比居中的图标高约 3px。 */}
      <span data-slot="tool-fallback-trigger-body" className="inline-flex min-w-0 items-baseline gap-1 text-start">
        <span
          data-slot="tool-fallback-trigger-label"
          className={cn(
            'relative inline-flex min-w-0 items-baseline gap-1.5 overflow-hidden text-start',
            isCancelled && 'text-muted-foreground line-through',
          )}
        >
          <span data-slot="tool-fallback-trigger-name" className="shrink-0 font-medium">
            {label}
          </span>
          {children}
        </span>
        {statusNode}
      </span>
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground',
          'transition-[transform,opacity]',
          'duration-(--animation-duration) ease-motion-standard motion-reduce:transition-none',
          isNarrow
            ? 'opacity-100'
            : 'opacity-0 group-hover/trigger:opacity-100 group-hover/tool-row:opacity-100 group-focus-visible/trigger:opacity-100',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0 group-data-[state=open]/trigger:opacity-100',
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  bodyClassName,
  scrollable = true,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent> & { bodyClassName?: string; scrollable?: boolean }) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        'relative overflow-hidden text-sm outline-none',
        'group/collapsible-content',
        'ease-motion-standard motion-reduce:animate-none',
        'data-closed:animate-collapsible-up',
        'data-open:animate-collapsible-down',
        'data-closed:fill-mode-forwards',
        'data-closed:pointer-events-none',
        'data-open:duration-(--animation-duration)',
        'data-closed:duration-(--animation-duration)',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'mt-0.5 flex flex-col gap-1.5 text-xs scrollbar-gutter-stable ease-motion-standard motion-reduce:animate-none',
          'group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1',
          'group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1',
          'group-data-open/collapsible-content:duration-(--animation-duration) group-data-closed/collapsible-content:duration-(--animation-duration)',
          scrollable ? 'max-h-40 overflow-y-auto pr-1' : 'overflow-visible',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<'div'> & { argsText?: string }) {
  if (!argsText) return null;
  return (
    <div
      data-slot="tool-fallback-args"
      className={cn('aui-tool-fallback-args-value rounded-md bg-muted/50 p-2.5 text-xs text-foreground/90 whitespace-pre-wrap', className)}
      {...props}
    >
      <pre className="whitespace-pre-wrap">{argsText}</pre>
    </div>
  );
}

function ToolFallbackConversationArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<'div'> & { argsText?: string }) {
  if (!argsText) return null;
  return (
    <div
      data-slot="tool-fallback-args"
      className={cn('aui-tool-fallback-args flex w-full justify-end', className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value max-w-10/12 whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border border-border/50 bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & { result?: unknown }) {
  if (result === undefined) return null;
  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return (
    <div
      data-slot="tool-fallback-result"
      className={cn('aui-tool-fallback-result max-h-35', className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-xs font-medium text-muted-foreground">结果：</p>
      <pre className="aui-tool-fallback-result-content mt-1 rounded-md bg-muted/50 p-2.5 text-xs text-foreground/90 whitespace-pre-wrap">
        {resultText}
      </pre>
    </div>
  );
}

function ToolFallbackCommandOutput({
  command,
  output,
  className,
  ...props
}: React.ComponentProps<'div'> & { command?: string; output?: string }) {
  if (!command && !output) return null;

  return (
    <div
      data-slot="tool-fallback-command"
      className={cn(
        'min-w-0 overflow-hidden rounded-xl border border-border/40 bg-[hsl(var(--surface-2))] font-mono text-code leading-[1.55]',
        'dark:border-transparent dark:bg-[hsl(0_0%_10%)]',
        className,
      )}
      {...props}
    >
      {command ? (
        <div
          data-slot="tool-fallback-command-line"
          className="px-4 pt-4 whitespace-pre-wrap wrap-anywhere text-foreground dark:text-[hsl(0_0%_90%)]"
        >
          <span className="select-none text-muted-foreground/55">$</span>
          {' '}
          <span>{command}</span>
        </div>
      ) : null}
      {output ? (
        <pre
          data-slot="tool-fallback-command-output"
          className={cn(
            'aui-tool-command-scroll m-0 max-h-72 overflow-x-hidden overflow-y-auto px-4 pb-4 whitespace-pre-wrap wrap-anywhere text-muted-foreground dark:text-[hsl(0_0%_56%)]',
            command ? 'mt-3' : 'pt-4',
          )}
        >
          {output}
        </pre>
      ) : null}
    </div>
  );
}

function ToolFallbackConversationResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & { result?: unknown }) {
  if (result === undefined) return null;
  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return (
    <div
        data-slot="tool-fallback-result"
        className={cn('aui-tool-fallback-result flex w-full justify-start', className)}
        {...props}
    >
      <div className="aui-tool-fallback-result-content aui-md min-w-0 max-w-full rounded-xl rounded-tl-md px-1 py-1 text-xs leading-6 text-foreground/84 bg-muted">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {resultText}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<'div'> & { status?: ToolCallMessagePartStatus }) {
  if (status?.type !== 'incomplete') return null;
  const error = status.error;
  const errorText = error ? (typeof error === 'string' ? error : JSON.stringify(error)) : null;
  if (!errorText) return null;
  const isCancelled = status.reason === 'cancelled';
  const headerText = isCancelled ? '取消原因：' : '错误：';
  return (
    <div
        data-slot="tool-fallback-error"
        className={cn("aui-tool-fallback-error", className)}
        {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">{headerText}</p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">{errorText}</p>
    </div>
  );
}

const APPROVED_RESULT = '用户已允许工具执行';
const DENIED_RESULT = '用户已拒绝工具执行';

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  ...props
}: React.ComponentProps<'div'> &
  Partial<Pick<ToolCallMessagePartProps, 'addResult' | 'resume' | 'respondToApproval'>> & {
    interrupt?: ToolCallMessagePart['interrupt'];
    approval?: ToolCallMessagePart['approval'];
  }) {
  const [submitted, setSubmitted] = useState(false);

  const respond = (approved: boolean) => {
    if (submitted) return;
    setSubmitted(true);
    if (approval != null && approval.approved === undefined && respondToApproval) {
      respondToApproval({ approved });
    } else if (interrupt) {
      resume?.({ approved });
    } else {
      addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    }
  };

  return (
    <div className={cn('flex items-center gap-2 border-t border-dashed px-4 pt-2', className)} {...props}>
      <Button size="sm" onClick={() => respond(true)} disabled={submitted}>
        允许
      </Button>
      <Button size="sm" variant="outline" onClick={() => respond(false)} disabled={submitted}>
        拒绝
      </Button>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';
  const isRequiresAction = status?.type === 'requires-action';
  const [open, setOpen] = useState(isRequiresAction);

  useEffect(() => {
    if (isRequiresAction) {
      setOpen(true);
    }
  }, [isRequiresAction]);

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen} className={cn(isCancelled && 'opacity-60')}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs argsText={argsText} className={cn(isCancelled && 'opacity-60')} />
        {isRequiresAction && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
          />
        )}
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  ConversationArgs: typeof ToolFallbackConversationArgs;
  Result: typeof ToolFallbackResult;
  CommandOutput: typeof ToolFallbackCommandOutput;
  ConversationResult: typeof ToolFallbackConversationResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = 'ToolFallback';
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.ConversationArgs = ToolFallbackConversationArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.CommandOutput = ToolFallbackCommandOutput;
ToolFallback.ConversationResult = ToolFallbackConversationResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackConversationArgs,
  ToolFallbackResult,
  ToolFallbackCommandOutput,
  ToolFallbackConversationResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
