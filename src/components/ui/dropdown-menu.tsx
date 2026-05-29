import { useState, useRef, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
}

export function DropdownMenu({ trigger, children, align = 'left' }: DropdownMenuProps) {
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
          className="fixed z-[100] min-w-[160px] rounded-md border bg-popover p-1 shadow-lg"
          style={{ top: pos.top, left: pos.left }}
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
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-accent',
        danger && 'text-destructive'
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
