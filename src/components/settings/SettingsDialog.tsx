import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ThemeToggle } from './ThemeToggle';
import { ProviderConfig } from './ProviderConfig';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <ThemeToggle />
          <ProviderConfig />
        </div>
      </DialogContent>
    </Dialog>
  );
}
