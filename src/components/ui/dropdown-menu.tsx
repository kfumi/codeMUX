import { useState, useRef, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  panelClassName?: string;
}

export function DropdownMenu({ trigger, children, align = 'left', panelClassName }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      left: align === 'left' ? rect.left : rect.right,
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [open]);

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          className={cn(
            'surface-panel fixed z-[160] min-w-[160px] rounded-lg border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_50px_-28px_hsl(var(--foreground)/0.4),0_0_0_1px_hsl(var(--background)/0.7)] backdrop-blur-md animate-in fade-in blur-in-4 fill-mode-both [animation-duration:180ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.98,hsl(var(--surface-1))/0.95)] dark:shadow-[0_24px_64px_-30px_hsl(var(--surface-shadow-strong)/0.98),0_0_0_1px_hsl(var(--foreground)/0.045)]',
            panelClassName,
          )}
          style={align === 'left' ? { top: pos.top, left: pos.left } : { top: pos.top, left: pos.left, transform: 'translateX(-100%)', '--tw-enter-translate-x': '-100%' } as React.CSSProperties}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div ref={triggerRef} onClick={() => setOpen(!open)}>{trigger}</div>
      {panel}
    </>
  );
}

interface DropdownMenuItemProps {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  icon?: ReactNode;
}

export function DropdownMenuItem({ children, onClick, danger, icon }: DropdownMenuItemProps) {
  return (
    <button
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground/82 transition-all duration-150 hover:bg-muted/72 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.9]',
        danger && 'text-destructive hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive'
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
