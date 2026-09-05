import { invoke } from '@tauri-apps/api/core';
import { Archive, Copy, Download, FolderOpen, Mail, MoreHorizontal, Pencil, Pin, PinOff, RotateCw, Timer } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { agentApi } from '../../lib/tauri';
import { resolveSessionWorkingPath } from '../../lib/sessionCwd';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { AgentMessage } from '../../stores/agentStore';
import { useAgentStore } from '../../stores/agentStore';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { TooltipHint } from '../ui/tooltip';

interface SessionHeaderProps {
  sessionId: string;
}

const EMPTY_SESSION_EVENTS: AgentMessage[] = [];

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
  const sessionEvents = useAgentStore((state) => state.events[sessionId] ?? EMPTY_SESSION_EVENTS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const resyncSessionFromNative = useAgentStore((state) => state.resyncSessionFromNative);
  const rememberedWorkingPath = useAgentStore((state) => state.sessionWorkingPaths[sessionId] ?? null);
  const workingPath = session
    ? resolveSessionWorkingPath(session, projects, {
      events: sessionEvents,
      rememberedPath: rememberedWorkingPath,
    })
    : null;

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

  const handleOpenInExplorer = async () => {
    if (!workingPath) {
      return;
    }
    try {
      await invoke('open_in_explorer', { path: workingPath });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const copyAgentSessionValue = async (field: 'agentSessionId' | 'messagePath') => {
    if (!session) return;
    const info = await agentApi.getSessionInfo(session.id, session.agent_kind);
    await copyText(info[field], field === 'messagePath' ? '未找到任务路径' : '未找到会话ID');
  };

  const handleArchive = async () => {
    await archiveSession(sessionId);
  };

  const canResyncFromCli = Boolean(
    session
    && !session.is_read_only
    && session.agent_kind !== 'gemini_cli',
  );

  const handleResyncFromCli = async () => {
    if (!canResyncFromCli) {
      return;
    }
    if (isRunning) {
      toast.error('会话正在运行，请先停止后再同步');
      return;
    }

    const toastId = toast.loading('正在从 CLI 同步历史…');
    try {
      const eventCount = await resyncSessionFromNative(sessionId);
      toast.success(`已从 CLI 同步 ${eventCount} 条历史消息`, { id: toastId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '从 CLI 同步历史失败', { id: toastId });
    }
  };

  return (
    <>
      <span className="min-w-0 truncate text-ui-title font-semibold text-foreground/88" data-tauri-drag-region>
        {session?.title || '新对话'}
      </span>
      {session?.origin === 'scheduled' && (
        <span className="flex shrink-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/8 px-1.5 py-0.5 text-ui-micro font-medium text-primary">
          <Timer className="h-3 w-3" /> 定时
        </span>
      )}
      {session?.origin === 'imported' && (
        <TooltipHint content={session.is_read_only ? '外部会话恢复失败，当前为只读快照' : '来自外部 CLI，可继续原生会话'}>
          <span className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/8 px-1.5 py-0.5 text-ui-micro font-medium text-amber-700 dark:text-amber-300">
            <Download className="h-3 w-3" /> {session.is_read_only ? '只读' : '外部'}
          </span>
        </TooltipHint>
      )}
      {workingPath ? (
        <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border/42 bg-[hsl(var(--surface-2))]/88 px-2 py-1 text-ui-meta text-foreground/68 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] dark:border-[hsl(var(--surface-edge))]/72 dark:bg-[hsl(var(--surface-3))]/74 dark:text-foreground/76 dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.045),0_8px_20px_-18px_hsl(var(--surface-shadow-strong)/0.9)] min-[640px]:flex">
          <FolderOpen className="h-3 w-3 shrink-0 text-foreground/54 dark:text-[hsl(var(--sidebar-accent))]/78" />
          <TooltipHint content={workingPath}>
            <span>{workingPath.split(/[/\\]+/).filter(Boolean).at(-1) ?? workingPath}</span>
          </TooltipHint>
        </div>
      ) : project ? (
        <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border/42 bg-[hsl(var(--surface-2))]/88 px-2 py-1 text-ui-meta text-foreground/68 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] dark:border-[hsl(var(--surface-edge))]/72 dark:bg-[hsl(var(--surface-3))]/74 dark:text-foreground/76 dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.045),0_8px_20px_-18px_hsl(var(--surface-shadow-strong)/0.9)] min-[640px]:flex">
          <FolderOpen className="h-3 w-3 shrink-0 text-foreground/54 dark:text-[hsl(var(--sidebar-accent))]/78" />
          <TooltipHint content={project.path}>
            <span>{project.path.split(/[/\\]+/).filter(Boolean).at(-1) ?? project.path}</span>
          </TooltipHint>
        </div>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="任务菜单"
            className="rounded-lg p-1 text-muted-foreground/66 transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            icon={session?.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            onClick={() => session && void setSessionPinned(session.id, !session.is_pinned)}
          >
            {session?.is_pinned ? '取消置顶任务' : '置顶任务'}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            onSelect={(event) => {
              event.preventDefault();
              window.setTimeout(() => handleRenameOpen(), 0);
            }}
          >
            重命名任务
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Archive className="h-3.5 w-3.5" />} onClick={() => void handleArchive()}>
            归档任务
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Mail className="h-3.5 w-3.5" />} onClick={() => markSessionUnread(sessionId)}>
            标记为未读
          </DropdownMenuItem>
          {canResyncFromCli ? (
            <DropdownMenuItem
              icon={<RotateCw className="h-3.5 w-3.5" />}
              onClick={() => void handleResyncFromCli()}
            >
              从 CLI 同步历史
            </DropdownMenuItem>
          ) : null}
          {workingPath ? (
            <>
              <DropdownMenuItem
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                onClick={() => void handleOpenInExplorer()}
              >
                在资源管理器中打开
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyText(workingPath)}>
                复制路径
              </DropdownMenuItem>
            </>
          ) : null}
          {session?.agent_kind !== 'opencode' && (
            <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyAgentSessionValue('messagePath')}>
              复制任务路径
            </DropdownMenuItem>
          )}
          <DropdownMenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyAgentSessionValue('agentSessionId')}>
            复制会话ID
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent overlayClassName="z-[170]" className="sm:max-w-100">
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
