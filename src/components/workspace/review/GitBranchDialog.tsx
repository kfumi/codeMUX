import { useEffect, useState } from 'react';

import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';

interface GitBranchDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (branchName: string, checkout: boolean) => void;
}

export function GitBranchDialog({
  open,
  loading,
  error,
  onOpenChange,
  onCreate,
}: GitBranchDialogProps) {
  const [branchName, setBranchName] = useState('');
  const [checkout, setCheckout] = useState(true);

  useEffect(() => {
    if (!open) {
      setBranchName('');
      setCheckout(true);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-105">
        <DialogHeader>
          <DialogTitle>新建分支</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">分支名</span>
            <Input
              aria-label="分支名"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="feature/git-panel"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={checkout}
              onChange={(event) => setCheckout(event.target.checked)}
            />
            创建后切换到新分支
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => onCreate(branchName, checkout)} disabled={loading || !branchName.trim()}>
            创建分支
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
