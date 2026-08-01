"use client";

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from 'lucide-react';
import {
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
  useScrollLock,
} from '@assistant-ui/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

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
      className={cn('aui-tool-fallback-root group/tool-fallback-root w-full py-1', className)}
      style={{ '--animation-duration': `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus['type'];
const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  'requires-action': AlertCircleIcon,
};

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';
  const Icon = statusIconMap[statusType];

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        'aui-tool-fallback-trigger group/trigger flex w-full items-center gap-2 text-sm text-muted-foreground/76 transition-colors hover:text-foreground/88 pl-1',
        className,
      )}
      {...props}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          isCancelled && 'text-muted-foreground/72',
          isRunning && 'animate-spin text-muted-foreground/72',
          statusType === 'complete' && 'text-muted-foreground/68',
          statusType === 'incomplete' && !isCancelled && 'text-[hsl(var(--destructive)/0.72)]',
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          'relative inline-flex items-center gap-2 text-start leading-none',
          isCancelled && 'text-muted-foreground line-through',
        )}
      >
        <span>
          <b>{toolName}</b>
        </span>
        {children}
      </span>
      <ChevronDownIcon
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground/52 transition-transform',
          'duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0',
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
        'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
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
          'mt-1 flex flex-col gap-2 text-xs scrollbar-gutter-stable ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
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
  ToolFallbackConversationResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
