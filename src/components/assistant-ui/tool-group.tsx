"use client";

import { memo, useCallback, useMemo, useState, type FC, type PropsWithChildren } from 'react';
import { ChevronDownIcon, LoaderIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { getToolDisplayName } from '@/components/agent/toolHeaderSummary';

const ANIMATION_DURATION = 0;

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
  // Generate label based on tool names if available
  const label = useMemo(() => {
    if (!toolNames || toolNames.length === 0) {
      return `${count} 次工具调用`;
    }

    // Count by tool name
    const counts = new Map<string, number>();
    for (const name of toolNames) {
      const displayName = getToolDisplayName(name);
      counts.set(displayName, (counts.get(displayName) || 0) + 1);
    }

    // Build summary
    const parts: string[] = [];
    for (const [name, count] of counts) {
      parts.push(`${count} 次 ${name}`);
    }

    if (parts.length === 1) {
      return `已执行 ${parts[0]}`;
    }
    if (parts.length <= 3) {
      return `已执行 ${parts.join('、')}`;
    }
    // Too many types, just show count
    return `${count} 次工具调用`;
  }, [count, toolNames]);

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        'aui-tool-group-trigger group/trigger flex items-center gap-2 text-sm text-muted-foreground/74 transition-colors hover:text-foreground/88',
        'group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4',
        'group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4',
        className,
      )}
      {...props}
    >
      {active && <LoaderIcon data-slot="tool-group-trigger-loader" className="size-4 shrink-0 animate-spin" />}
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          'aui-tool-group-trigger-label-wrapper relative inline-block text-start leading-none font-medium',
          'group-data-[variant=outline]/tool-group-root:grow',
          'group-data-[variant=muted]/tool-group-root:grow',
        )}
      >
        <span>{label}</span>
        {active && (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          'size-4 shrink-0 transition-transform',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0',
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
        'relative text-sm outline-none',
        'group/collapsible-content',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'mt-2 flex flex-col gap-2',
          'group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3',
          'group-data-[variant=muted]/tool-group-root:mt-3 group-data-[variant=muted]/tool-group-root:border-t group-data-[variant=muted]/tool-group-root:px-4 group-data-[variant=muted]/tool-group-root:pt-3',
        )}
      >
        {children}
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

export { ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, toolGroupVariants };
