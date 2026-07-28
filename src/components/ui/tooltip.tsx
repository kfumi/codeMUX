import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-lg border border-border/60 bg-popover/96 px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-[0_16px_40px_-18px_hsl(var(--foreground)/0.38)] backdrop-blur-sm animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

type TooltipHintProps = {
  content?: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delayDuration?: number;
  children: React.ReactElement;
};

/**
 * Wrap any single element with a tooltip. When `content` is null/undefined/empty,
 * renders children as-is without a tooltip wrapper (matching the semantics of the
 * native `title` attribute which is omitted when set to undefined).
 *
 * The child must be a single element that forwards refs and spreads props onto
 * its root DOM node (native HTML elements, shadcn components, assistant-ui
 * primitives all qualify) so that Radix `Slot` can merge trigger props.
 */
export function TooltipHint({
  content,
  side = 'top',
  delayDuration = 300,
  children,
}: TooltipHintProps) {
  if (content == null || content === '') {
    return children;
  }
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
