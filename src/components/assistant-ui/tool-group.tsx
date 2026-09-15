"use client";

import { memo, useCallback, useMemo, useRef, useState, type FC, type PropsWithChildren } from 'react';
import { ChevronDownIcon, WrenchIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { useScrollLock } from '@assistant-ui/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';
import { getToolDisplayName, getToolGroupPhrase } from '@/components/agent/toolHeaderSummary';

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
  running = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
  toolNames?: string[];
  active?: boolean;
  running?: boolean;
}) {
  const summary = useMemo(
    () => buildToolGroupSummary(toolNames, count),
    [count, toolNames],
  );
  // 窄屏没有 hover:展开箭头常显(触发按钮本身可点,但箭头指示不应隐形)。
  const isNarrow = useIsNarrowViewport();

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      data-active={active ? 'true' : 'false'}
      aria-busy={active || undefined}
      className={cn(
        'aui-tool-group-trigger group/trigger flex items-center gap-2 text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78',
        'data-[active=true]:text-muted-foreground/80',
        'group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4',
        'group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4',
        className,
      )}
      {...props}
    >
      <WrenchIcon
        aria-hidden
        data-slot="tool-group-trigger-icon"
        className={cn(
          'size-4 shrink-0',
          active && 'text-[hsl(var(--primary)/0.78)]',
        )}
      />
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          'aui-tool-group-trigger-label-wrapper relative inline-block text-start leading-none font-normal',
          'group-data-[variant=outline]/tool-group-root:grow',
          'group-data-[variant=muted]/tool-group-root:grow',
        )}
      >
        <ToolGroupTriggerLabel summary={summary} running={running} />
        {active && (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            <ToolGroupTriggerLabel summary={summary} running={running} />
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          'size-4 shrink-0',
          'transition-[transform,opacity]',
          'duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
          isNarrow
            ? 'opacity-100'
            : 'opacity-0 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100',
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
          'relative mt-3.5',
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

type ToolGroupProps = {
  startIndex: number;
  endIndex: number;
  toolNames?: string[];
  active?: boolean;
  running?: boolean;
};

type ToolGroupComponent = FC<PropsWithChildren<ToolGroupProps>> & {
  Root: typeof ToolGroupRoot;
  Trigger: typeof ToolGroupTrigger;
  Content: typeof ToolGroupContent;
};

const ToolGroupImpl: FC<PropsWithChildren<ToolGroupProps>> = ({
  children,
  startIndex,
  endIndex,
  toolNames,
  active = false,
  running = false,
}) => {
  const toolCount = endIndex - startIndex + 1;

  return (
    <ToolGroupRoot
      variant="ghost"
      data-active={active ? 'true' : 'false'}
    >
      <ToolGroupTrigger count={toolCount} toolNames={toolNames} active={active} running={running} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const ToolGroup = memo(ToolGroupImpl) as unknown as ToolGroupComponent;
ToolGroup.displayName = 'ToolGroup';
ToolGroup.Root = ToolGroupRoot;
ToolGroup.Trigger = ToolGroupTrigger;
ToolGroup.Content = ToolGroupContent;

function ToolGroupTriggerLabel({ summary, running = false }: { summary?: string; running?: boolean }) {
  return (
    <span className="inline-flex items-baseline">
      {running ? <span>运行中</span> : null}
      {summary ? (
        <>
          {running ? (
            <span
              data-slot="tool-group-trigger-dot"
              className="mx-2 select-none"
            >
              ·
            </span>
          ) : null}
          <span data-slot="tool-group-trigger-summary">{summary}</span>
        </>
      ) : null}
    </span>
  );
}

export function buildToolGroupSummary(toolNames?: string[], count = toolNames?.length ?? 0): string | undefined {
  if (!toolNames || toolNames.length === 0) {
    return count > 0 ? `调用 ${count} 次工具` : undefined;
  }

  const groups = new Map<string, { count: number; toolName: string }>();
  for (const name of toolNames) {
    const displayName = getToolDisplayName(name);
    const entry = groups.get(displayName);
    if (entry) {
      entry.count += 1;
    } else {
      groups.set(displayName, { count: 1, toolName: name });
    }
  }

  return [...groups.values()]
    .map((entry) => getToolGroupPhrase(entry.toolName, entry.count))
    .join(' · ');
}

export function buildToolGroupLabel(toolNames?: string[], count = toolNames?.length ?? 0, running = false): string {
  const summary = buildToolGroupSummary(toolNames, count);
  if (running) {
    return summary ? `运行中 · ${summary}` : '运行中';
  }
  return summary ?? '';
}

export { ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, toolGroupVariants };
