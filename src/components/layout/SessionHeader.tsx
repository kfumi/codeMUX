import { FolderOpen, MoreHorizontal, Pencil } from 'lucide-react';
import { useState } from 'react';

import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface SessionHeaderProps {
  sessionId: string;
}

export function SessionHeader({ sessionId }: SessionHeaderProps) {
  const { sessions, updateSessionTitle } = useSessionStore();
  const { projects } = useProjectStore();

  const session = sessions.find((entry) => entry.id === sessionId);
  const project = session?.project_id ? projects.find((entry) => entry.id === session.project_id) : null;

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const handleRenameOpen = () => {
    setRenameValue(session?.title || '');
    setRenameOpen(true);
  };

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session?.title) {
      await updateSessionTitle(sessionId, trimmed);
    }
    setRenameOpen(false);
  };

  return (
    <>
      <span className="min-w-0 truncate text-[14px] font-semibold text-foreground/88" data-tauri-drag-region>
        {session?.title || '新对话'}
      </span>
      {project && (
        <div className="hidden shrink-0 items-center gap-1.5 rounded-md bg-[hsl(var(--surface-2))]/72 px-2 py-1 text-[12px] text-foreground/60 min-[640px]:flex">
          <FolderOpen className="h-3 w-3 shrink-0 text-foreground/50" />
          <span>{project.name}</span>
        </div>
      )}
      <DropdownMenu
        trigger={(
          <button className="rounded-lg p-1 text-muted-foreground/66 transition-colors hover:bg-muted/55 hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      >
        <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameOpen}>
          重命名
        </DropdownMenuItem>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-100">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleRenameSave();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={() => void handleRenameSave()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
