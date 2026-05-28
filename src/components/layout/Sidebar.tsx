import { SessionList } from '../session/SessionList';
import { Button } from '../ui/button';
import { Plus, Settings } from 'lucide-react';

interface SidebarProps {
  onNewSession: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ onNewSession, onOpenSettings }: SidebarProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <h1 className="text-xl font-bold">codeMUX</h1>
      </div>
      <div className="p-2">
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onNewSession}>
          <Plus className="h-4 w-4" />
          新对话
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        <SessionList />
      </div>
      <div className="p-2 border-t">
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </div>
  );
}
