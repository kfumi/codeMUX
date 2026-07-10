"use client";

import { createContext, memo, useCallback, useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import {
  useAuiState,
  type ReasoningGroupComponent,
  type ReasoningMessagePartComponent,
} from '@assistant-ui/react';
import { MarkdownText } from '@/components/assistant-ui/markdown-text';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const ANIMATION_DURATION = 0;
const ReasoningOpenContext = createContext(false);

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tokens`;
  return `${value} tokens`;
}

const reasoningVariants = cva('aui-reasoning-root w-full', {
  variants: {
    variant: {
      outline: 'rounded-lg border border-border/62 bg-[hsl(var(--surface-2))]/48 px-3 py-1.5',
      ghost: '',
      muted: 'rounded-lg border border-border/54 bg-[hsl(var(--surface-2))]/58 px-3 py-1.5',
    },
  },
  defaultVariants: {
    variant: 'outline',
  },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ReasoningRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange],
  );

  return (
    <ReasoningOpenContext.Provider value={isOpen}>
      <Collapsible
        data-slot="reasoning-root"
        data-variant={variant}
        open={isOpen}
        onOpenChange={handleOpenChange}
        className={cn('group/reasoning-root', reasoningVariants({ variant, className }))}
        style={{ '--animation-duration': `${ANIMATION_DURATION}ms` } as React.CSSProperties}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningOpenContext.Provider>
  );
}

function ReasoningFade({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        'aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8',
        'bg-[linear-gradient(to_top,var(--color-background),transparent)]',
        'group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,hsl(var(--muted)/0.5),transparent)]',
        className,
      )}
      {...props}
    />
  );
}

function ReasoningTrigger({
  active,
  duration,
  tokenCount,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
  tokenCount?: number;
}) {
  const durationText = duration != null ? ` (${duration}s)` : '';
  const tokenText = tokenCount != null && tokenCount > 0 ? ` · ${formatCompactTokens(tokenCount)}` : '';
  const label = `思考${durationText}${tokenText}`;

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        'aui-reasoning-trigger group/trigger text-muted-foreground/78 hover:text-foreground flex max-w-[75%] items-center gap-2 py-1 text-sm transition-colors',
        className,
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper relative inline-block leading-none"
      >
        <span>{label}</span>
        {active ? (
          <span
            aria-hidden
            data-slot="reasoning-trigger-shimmer"
            className="aui-reasoning-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          'aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0',
          'transition-transform',
          'group-data-[state=closed]/trigger:-rotate-90',
          'group-data-[state=open]/trigger:rotate-0',
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        'aui-reasoning-content text-muted-foreground relative text-xs outline-none',
        'group/collapsible-content',
        className,
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

function ReasoningText({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="reasoning-text"
      className={cn(
        'aui-reasoning-text relative z-0 max-h-40 overflow-y-auto ps-6 pt-2 pe-2 pb-2 leading-relaxed scrollbar-gutter-stable',
        '[&_.aui-md-h1]:text-sm [&_.aui-md-h1]:leading-5',
        '[&_.aui-md-h2]:text-sm [&_.aui-md-h2]:leading-5',
        '[&_.aui-md-h3]:text-xs [&_.aui-md-h3]:leading-5',
        '[&_.aui-md-h4]:text-xs [&_.aui-md-h4]:leading-5',
        '[&_.aui-md-h5]:text-xs [&_.aui-md-h5]:leading-5',
        '[&_.aui-md-h6]:text-xs [&_.aui-md-h6]:leading-5',
        '[&_.aui-md-table]:text-xs',
        '[&_[data-streamdown=\'code-block\']]:text-[11px]',
        '[&_[data-streamdown=\'code-block-header\']]:text-[11px]',
        '[&_[data-streamdown=\'code-block-body\']]:text-[11px]',
        '[&_pre]:text-[11px] [&_code]:text-[11px]',
        className,
      )}
      {...props}
    />
  );
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const ReasoningGroupImpl: ReasoningGroupComponent = ({ children, startIndex, endIndex }) => {
  const isReasoningStreaming = useAuiState((s) => {
    if (s.message.status?.type !== 'running') return false;
    const lastIndex = s.message.parts.length - 1;
    if (lastIndex < 0) return false;
    const lastType = s.message.parts[lastIndex]?.type;
    if (lastType !== 'reasoning') return false;
    return lastIndex >= startIndex && lastIndex <= endIndex;
  });
  const [isOpen, setIsOpen] = useState(false);

  return (
    <ReasoningRoot open={isOpen} onOpenChange={setIsOpen} variant="ghost">
      <ReasoningTrigger active={isReasoningStreaming} />
      <ReasoningContent aria-busy={isReasoningStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
  Fade: typeof ReasoningFade;
};

Reasoning.displayName = 'Reasoning';
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = 'ReasoningGroup';

export {
  Reasoning,
  ReasoningContent,
  ReasoningFade,
  ReasoningGroup,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
  reasoningVariants,
};
