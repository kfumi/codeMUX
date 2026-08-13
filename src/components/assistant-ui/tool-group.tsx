"use client";

import { memo, useCallback, useMemo, useRef, useState, type FC, type PropsWithChildren } from 'react';
import { ChevronDownIcon, CompassIcon, LoaderIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { useScrollLock } from '@assistant-ui/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { getToolDisplayName } from '@/components/agent/toolHeaderSummary';

const ANIMATION_DURATION = 200;

const toolGroupVariants = cva('aui-tool-group-root group/tool-group w-full', {
  variants: {
    variant: {
      outline: 'rounded-lg border py-3',
      ghost: '',
      muted: 'rounded-lg border border-border/30 bg-[hsl(var(--surface-2))]/32 py-3',
    },
  },
  defaultVariants: { variant: 'outline' },
});

export type ToolGroupRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> &
  VariantProps<typeof toolGroupVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

function ToolGroupRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolGroupRootProps) {
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
      data-slot="tool-group-root"
      data-variant={variant ?? 'outline'}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(toolGroupVariants({ variant }), 'group/tool-group-root', className)}
      style={{ '--animation-duration': `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolGroupTrigger({
  count,
  toolNames,
  active = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
  toolNames?: string[];
  active?: boolean;
}) {
  const summary = useMemo(
    () => buildToolGroupSummary(toolNames, count),
    [count, toolNames],
  );

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        'aui-tool-group-trigger group/trigger flex items-center gap-2 text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78',
        'group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4',
        'group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4',
        className,
      )}
      {...props}
    >
      <CompassIcon
        aria-hidden
        data-slot="tool-group-trigger-icon"
        className="size-4 shrink-0"
      />
      {active && <LoaderIcon data-slot="tool-group-trigger-loader" className="size-4 shrink-0 animate-spin" />}
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          'aui-tool-group-trigger-label-wrapper relative inline-block text-start leading-none font-normal',
          'group-data-[variant=outline]/tool-group-root:grow',
          'group-data-[variant=muted]/tool-group-root:grow',
        )}
      >
        <ToolGroupTriggerLabel summary={summary} />
        {active && (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            <ToolGroupTriggerLabel summary={summary} />
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          'size-4 shrink-0',
          'opacity-0 transition-[transform,opacity]',
          'duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
          'group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0 group-data-[state=open]/trigger:opacity-100',
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolGroupContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
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
          'relative mt-1.5',
          'group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3',
          'group-data-[variant=muted]/tool-group-root:mt-3 group-data-[variant=muted]/tool-group-root:border-t group-data-[variant=muted]/tool-group-root:px-4 group-data-[variant=muted]/tool-group-root:pt-3',
          'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
          'group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1',
          'group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1',
          'group-data-open/collapsible-content:duration-(--animation-duration) group-data-closed/collapsible-content:duration-(--animation-duration)',
        )}
      >
        <div
          aria-hidden
          data-slot="tool-group-rail"
          className="pointer-events-none absolute top-0 bottom-1 left-2 w-px bg-muted-foreground/18 group-data-[variant=outline]/tool-group-root:left-6 group-data-[variant=muted]/tool-group-root:left-6"
        />
        <div className="flex flex-col gap-1.5 pl-5">{children}</div>
      </div>
    </CollapsibleContent>
  );
}

type ToolGroupComponent = FC<PropsWithChildren<{ startIndex: number; endIndex: number; toolNames?: string[] }>> & {
  Root: typeof ToolGroupRoot;
  Trigger: typeof ToolGroupTrigger;
  Content: typeof ToolGroupContent;
};

const ToolGroupImpl: FC<PropsWithChildren<{ startIndex: number; endIndex: number; toolNames?: string[] }>> = ({
  children,
  startIndex,
  endIndex,
  toolNames,
}) => {
  const toolCount = endIndex - startIndex + 1;

  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger count={toolCount} toolNames={toolNames} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const ToolGroup = memo(ToolGroupImpl) as unknown as ToolGroupComponent;
ToolGroup.displayName = 'ToolGroup';
ToolGroup.Root = ToolGroupRoot;
ToolGroup.Trigger = ToolGroupTrigger;
ToolGroup.Content = ToolGroupContent;

function ToolGroupTriggerLabel({ summary }: { summary?: string }) {
  return (
    <span className="inline-flex items-baseline">
      <span>探索</span>
      {summary ? (
        <>
          <span
            data-slot="tool-group-trigger-dot"
            className="mx-2 select-none"
          >
            ·
          </span>
          <span data-slot="tool-group-trigger-summary">{summary}</span>
        </>
      ) : null}
    </span>
  );
}

export function buildToolGroupSummary(toolNames?: string[], count = toolNames?.length ?? 0): string | undefined {
  if (!toolNames || toolNames.length === 0) {
    return count > 0 ? `工具调用×${count}` : undefined;
  }

  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const displayName = getToolDisplayName(name);
    counts.set(displayName, (counts.get(displayName) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, toolCount] of counts) {
    parts.push(`${name}×${toolCount}`);
  }

  return parts.join('、');
}

export function buildToolGroupLabel(toolNames?: string[], count = toolNames?.length ?? 0): string {
  const summary = buildToolGroupSummary(toolNames, count);
  return summary ? `探索·${summary}` : '探索';
}

export { ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, toolGroupVariants };
