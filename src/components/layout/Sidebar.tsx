import { SessionList } from '../session/SessionList';
import { Button } from '../ui/button';
import { Plus, Settings } from 'lucide-react';

interface SidebarProps {
  onNewSession: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ onNewSession, onOpenSettings }: SidebarProps) {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-3 border-b">
        <h1 className="text-lg font-bold text-foreground">codeMUX</h1>
      </div>

      {/* Top actions */}
      <div className="p-2 space-y-1">
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={onNewSession}>
          <Plus className="h-4 w-4" />
          快速对话
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-auto">
        <div className="px-2 py-1">
          <span className="text-xs text-muted-foreground px-2">对话</span>
        </div>
        <SessionList />
      </div>

      {/* Bottom settings */}
      <div className="p-2 border-t">
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </div>
  );
}
