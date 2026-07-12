import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  overlayClassName?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'default',
  onConfirm,
  loading = false,
  overlayClassName,
}: ConfirmDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isLoading = loading || isSubmitting;

  const handleConfirm = async () => {
    if (isLoading) return;
    setIsSubmitting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent overlayClassName={overlayClassName} className="sm:max-w-95 gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pb-4 pt-6">
          <div className="flex items-start gap-3">
            {variant === 'destructive' && (
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--destructive)/0.1)]">
                <AlertTriangle className="h-4.5 w-4.5 text-[hsl(var(--destructive))]" />
              </div>
            )}
            <div className="space-y-1.5">
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2 border-t border-border/40 bg-muted/30 px-6 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
            className="h-8 px-3.5 text-[13px]"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={isLoading}
            className="h-8 gap-1.5 px-3.5 text-[13px]"
          >
            {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isLoading ? '正在删除…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
