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
            'surface-panel fixed z-[100] min-w-[160px] rounded-xl border border-border/60 bg-popover/98 p-1.5 backdrop-blur-sm dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.98,hsl(var(--surface-1))/0.94)]',
            panelClassName,
          )}
          style={align === 'left' ? { top: pos.top, left: pos.left } : { top: pos.top, left: pos.left, transform: 'translateX(-100%)' }}
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
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer transition-all duration-200 hover:bg-accent/70 dark:hover:bg-[hsl(var(--surface-3))/0.88]',
        danger && 'text-destructive'
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
