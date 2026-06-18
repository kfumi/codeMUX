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
            'surface-panel fixed z-160 min-w-40 rounded-md border border-border/70 bg-popover/98 p-1.5 shadow-[0_16px_42px_-28px_hsl(var(--foreground)/0.34),0_0_0_1px_hsl(var(--background)/0.68)] backdrop-blur-md animate-in fade-in blur-in-4 fill-mode-both animation-duration-[160ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.96,hsl(var(--surface-1))/0.94)] dark:shadow-[0_22px_56px_-34px_hsl(var(--surface-shadow-strong)/0.9),0_0_0_1px_hsl(var(--foreground)/0.034)]',
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
      <div ref={triggerRef} role="button" onClick={() => setOpen(!open)}>{trigger}</div>
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
        'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-foreground/82 transition-all duration-150 hover:bg-muted/62 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.78]',
        danger && 'text-destructive hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive'
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
