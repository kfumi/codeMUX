"use client";

import { memo, useCallback, useEffect, useState } from 'react';
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
} from '@assistant-ui/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

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
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) setUncontrolledOpen(open);
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn('aui-tool-fallback-root group/tool-fallback-root w-full rounded-lg border py-3', className)}
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
  const label = isCancelled ? '已取消工具' : '已使用工具';

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        'aui-tool-fallback-trigger group/trigger flex w-full items-center gap-2 px-4 text-sm transition-colors',
        className,
      )}
      {...props}
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          isCancelled && 'text-muted-foreground',
          isRunning && 'animate-spin text-primary',
          statusType === 'complete' && 'text-[hsl(var(--success))]',
          statusType === 'incomplete' && !isCancelled && 'text-[hsl(var(--destructive))]',
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          'relative inline-block grow text-start leading-none',
          isCancelled && 'text-muted-foreground line-through',
        )}
      >
        <span>
          {label}: <b>{toolName}</b>
        </span>
        {children}
      </span>
      <ChevronDownIcon
        className={cn(
          'size-4 shrink-0 transition-transform duration-(--animation-duration) ease-out',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0',
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        'relative overflow-hidden text-sm outline-none',
        'group/collapsible-content ease-out',
        'data-[state=closed]:animate-collapsible-up',
        'data-[state=open]:animate-collapsible-down',
        'data-[state=closed]:fill-mode-forwards',
        'data-[state=closed]:pointer-events-none',
        'data-[state=open]:duration-(--animation-duration)',
        'data-[state=closed]:duration-(--animation-duration)',
        className,
      )}
      {...props}
    >
      <div className="mt-3 flex max-h-105 flex-col gap-2 overflow-y-auto border-t pt-2 pr-1 text-xs scrollbar-gutter-stable">{children}</div>
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
    <div className={cn('aui-tool-fallback-args px-4', className)} {...props}>
      <pre className="whitespace-pre-wrap">{argsText}</pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & { result?: unknown }) {
  if (result === undefined) return null;
  return (
    <div className={cn('border-t border-dashed px-4 pt-2', className)} {...props}>
      <p className="font-semibold">结果：</p>
      <pre className="whitespace-pre-wrap">
        {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
      </pre>
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
    <div className={cn('px-4', className)} {...props}>
      <p className="text-muted-foreground font-semibold">{headerText}</p>
      <p className="text-muted-foreground">{errorText}</p>
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
    <ToolFallbackRoot open={open} onOpenChange={setOpen} className={cn(isCancelled && 'border-muted-foreground/30 bg-muted/30')}>
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
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = 'ToolFallback';
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
