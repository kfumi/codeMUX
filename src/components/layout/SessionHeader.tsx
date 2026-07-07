import { invoke } from '@tauri-apps/api/core';
import { Archive, Copy, FolderOpen, Mail, MoreHorizontal, Pencil, Pin, PinOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { agentApi } from '../../lib/tauri';
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
  const {
    sessions,
    updateSessionTitle,
    setSessionPinned,
    archiveSession,
    markSessionUnread,
  } = useSessionStore();
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

  const copyText = async (value: string | null | undefined, missingMessage = '没有可复制的内容') => {
    if (!value) {
      toast.error(missingMessage);
      return;
    }
    await navigator.clipboard.writeText(value);
    toast.success('已复制');
  };

  const copyAgentSessionValue = async (field: 'agentSessionId' | 'messagePath') => {
    if (!session) return;
    const info = await agentApi.getSessionInfo(session.id, session.agent_kind);
    await copyText(info[field], field === 'messagePath' ? '未找到任务路径' : '未找到会话ID');
  };

  const handleArchive = async () => {
    await archiveSession(sessionId);
  };

  return (
    <>
      <span className="min-w-0 truncate text-[14px] font-semibold text-foreground/88" data-tauri-drag-region>
        {session?.title || '新对话'}
      </span>
      {project && (
        <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border/42 bg-[hsl(var(--surface-2))]/88 px-2 py-1 text-[12px] text-foreground/68 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] dark:border-[hsl(var(--surface-edge))]/72 dark:bg-[hsl(var(--surface-3))]/74 dark:text-foreground/76 dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.045),0_8px_20px_-18px_hsl(var(--surface-shadow-strong)/0.9)] min-[640px]:flex">
          <FolderOpen className="h-3 w-3 shrink-0 text-foreground/54 dark:text-[hsl(var(--sidebar-accent))]/78" />
          <span>{project.name}</span>
        </div>
      )}
      <DropdownMenu
        trigger={(
          <button
            aria-label="任务菜单"
            className="rounded-lg p-1 text-muted-foreground/66 transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      >
        <DropdownMenuItem
          icon={session?.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          onClick={() => session && void setSessionPinned(session.id, !session.is_pinned)}
        >
          {session?.is_pinned ? '取消置顶任务' : '置顶任务'}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameOpen}>
          重命名任务
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Archive className="h-3.5 w-3.5" />} onClick={() => void handleArchive()}>
          归档任务
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Mail className="h-3.5 w-3.5" />} onClick={() => markSessionUnread(sessionId)}>
          标记为未读
        </DropdownMenuItem>
        {project && (
          <>
            <DropdownMenuItem
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              onClick={() => void invoke('open_in_explorer', { path: project.path })}
            >
              在资源管理器中打开
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyText(project.path)}>
              复制路径
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyAgentSessionValue('messagePath')}>
          复制任务路径
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyAgentSessionValue('agentSessionId')}>
          复制会话ID
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
