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
        'z-50 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-ui-caption text-popover-foreground shadow-[0_10px_28px_-20px_hsl(var(--surface-shadow-strong)/0.45)] animate-in fade-in fill-mode-forwards animation-duration-[160ms] [animation-timing-function:ease-out]',
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
