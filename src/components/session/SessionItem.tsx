import { useState } from 'react';
import { Archive, Loader2, LockKeyhole, FolderOpen, Pencil, Pin, PinOff, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { resolveSessionWorkingPath } from '../../lib/sessionCwd';
import { shellFacade } from '../../lib/facades/shell-facade';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useSessionFlowActive } from '../../hooks/useSessionFlowActive';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { SessionInfoCard } from './SessionInfoCard';
import { TooltipHint } from '../ui/tooltip';
import { sessionAwaitsUserConfirmation } from '../../lib/pendingUserInput';
import { cn } from '../../lib/utils';
import type { AgentPermissionRequest } from '../../types/agent';
import { getAgentDefinition, type AgentDefinition } from '../../types/agentRegistry';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types/session';

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_PERMISSIONS: AgentPermissionRequest[] = [];

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onTogglePinned: (pinned: boolean) => void;
  onArchive: () => void;
  onDelete: () => void;
  archiveLabel?: string;
  archiveIcon?: 'archive' | 'unarchive';
  onRename: (title: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分`;
  if (diffHour < 24) return `${diffHour}时`;
  if (diffMonth < 12) return `${diffDay}天`;
  if (diffYear < 1) return `${diffMonth}月`;
  return `${diffYear}年`;
}

function SessionStatusIcon({
  session,
  isActive,
  agentDef,
}: {
  session: Session;
  isActive: boolean;
  agentDef: AgentDefinition | undefined;
}) {
  // 状态点跟随智能体图标右下角(参考 圆点头像徽章):进行中=黄色、出错=红色、
  // 未读=绿色;"进行中"的转圈统一放到行右侧(时间/操作区域)。
  const flowActive = useSessionFlowActive(session.id);
  const hasError = useAgentStore((s) => !!s.error[session.id]);
  const isUnread = useSessionStore((s) => s.unreadSessions.has(session.id));

  const dotColor = flowActive
    ? 'bg-[hsl(var(--warning))]'
    : hasError
      ? 'bg-[hsl(var(--destructive))]'
      : isUnread
        ? 'bg-[hsl(var(--success))]'
        : null;

  return (
    <span className={cn('relative flex h-4 w-4 shrink-0 transition-opacity duration-normal', isActive ? 'opacity-100' : 'opacity-70')}>
      {agentDef ? (
        <AgentBrandIcon agent={agentDef} size="sm" />
      ) : (
        <span className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ui-micro font-semibold tracking-normal',
          isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64',
        )}>
          {session.agent_kind?.slice(0, 2).toUpperCase() || '??'}
        </span>
      )}
      {dotColor && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-[1.5px] border-[hsl(var(--sidebar-bg))]',
            dotColor,
          )}
        />
      )}
    </span>
  );
}

export function SessionItem({
  session,
  isActive,
  onClick,
  onTogglePinned,
  onArchive,
  onDelete,
  archiveLabel = '归档',
  archiveIcon = 'archive',
  onRename,
}: SessionItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // 窄屏抽屉没有 hover:右侧置顶/归档按钮簇不渲染(免得 opacity-0 的幽灵触控区
  // 拦截点击),操作统一走长按/右键菜单;桌面保持 hover 展开不变。
  const isNarrow = useIsNarrowViewport();
  const canOpenExplorer = useHostCapabilities().has('shell.explorer');
  const agentDef = getAgentDefinition(session.agent_kind);
  const flowActive = useSessionFlowActive(session.id);
  const awaitsConfirmation = useAgentStore((state) => sessionAwaitsUserConfirmation(
    state.events[session.id] ?? EMPTY_EVENTS,
    state.pendingPermissions[session.id] ?? EMPTY_PERMISSIONS,
  ));
  const sessionEvents = useAgentStore((state) => state.events[session.id] ?? EMPTY_EVENTS);
  const rememberedWorkingPath = useAgentStore((state) => state.sessionWorkingPaths[session.id] ?? null);
  const projects = useProjectStore((state) => state.projects);
  const latestSession = useSessionStore((state) => (
    state.sessions.find((entry) => entry.id === session.id)
    ?? state.archivedSessions.find((entry) => entry.id === session.id)
    ?? session
  ));
  const workingPath = resolveSessionWorkingPath(latestSession, projects, {
    events: sessionEvents,
    rememberedPath: rememberedWorkingPath,
  });
  const timeLabel = formatRelativeTime(session.updated_at);
  const ArchiveIcon = archiveIcon === 'archive' ? Archive : Undo2;
  const PinIcon = session.is_pinned ? PinOff : Pin;

  const handleRenameStart = () => {
    setRenameValue(session.title || '');
    setRenaming(true);
  };

  const handleRenameCommit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    }
    setRenaming(false);
  };

  const handleArchive = () => {
    onArchive();
  };

  const handleTogglePinned = () => {
    onTogglePinned(!session.is_pinned);
  };

  const handleDelete = () => {
    window.setTimeout(() => setConfirmOpen(true), 0);
  };

  const handleOpenInExplorer = async () => {
    if (!workingPath) {
      return;
    }
    try {
      await shellFacade.openInExplorer(workingPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <HoverCard
        openDelay={400}
        closeDelay={120}
        open={isNarrow || renaming ? false : undefined}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <HoverCardTrigger asChild>
              <div
                className={cn(
                  'group relative flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm transition-colors duration-fast select-none [-webkit-touch-callout:none]',
                  'cursor-pointer text-[hsl(var(--sidebar-fg))]/86',
                  'hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]',
                  'dark:hover:border-[hsl(var(--sidebar-glow))]/14 dark:hover:bg-[hsl(var(--surface-3))]/74',
                  isActive && 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--sidebar-fg))] dark:border-[hsl(var(--sidebar-border))]/70 dark:bg-[hsl(var(--foreground)/0.105)]',
                )}
                onClick={onClick}
              >
                <SessionStatusIcon session={session} isActive={isActive} agentDef={agentDef} />

                {renaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={handleRenameCommit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleRenameCommit();
                      if (event.key === 'Escape') setRenaming(false);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="flex-1 min-w-0 rounded-md border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-muted))] px-2 py-1 text-ui-title text-[hsl(var(--sidebar-fg))] outline-none transition-colors focus:border-[hsl(var(--sidebar-glow))]/35"
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate font-medium transition-colors duration-normal">
                      {session.title || '未命名对话'}
                    </span>
                    {session.is_read_only && (
                      <TooltipHint content="导入的只读快照">
                        <LockKeyhole className="h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/42" aria-label="只读会话" />
                      </TooltipHint>
                    )}
                    <span className="relative flex h-5 shrink-0 items-center justify-end transition-[width] duration-fast group-hover:w-12">
                      <span className={cn('inline-flex h-full items-center transition-opacity duration-fast', 'group-hover:opacity-0')}>
                        {awaitsConfirmation ? (
                          <span className="inline-flex h-4 items-center rounded-full bg-[hsl(var(--success))] px-1.5 text-ui-micro font-medium leading-4 text-white">
                            等待确认
                          </span>
                        ) : flowActive ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--warning))]" />
                        ) : (
                          <span className="text-ui-compact tabular-nums text-[hsl(var(--sidebar-fg))]/70">
                            {timeLabel}
                          </span>
                        )}
                      </span>
                      {/* 窄屏没有 hover:按钮簇不渲染,免得 opacity-0 的幽灵触控区拦截点击。 */}
                      {isNarrow ? null : (
                        <span className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100">
                          <TooltipHint content={session.is_pinned ? '取消置顶对话' : '置顶对话'}>
                            <button
                              className={cn(
                                'rounded-md p-1 transition-colors duration-fast',
                                session.is_pinned ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/42',
                                'hover:bg-[hsl(var(--sidebar-bg))] hover:text-[hsl(var(--sidebar-fg))]',
                              )}
                              aria-label={session.is_pinned ? '取消置顶对话' : '置顶对话'}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleTogglePinned();
                              }}
                            >
                              <PinIcon className="h-3.5 w-3.5" />
                            </button>
                          </TooltipHint>
                          <TooltipHint content={archiveLabel}>
                            <button
                              className={cn(
                                'rounded-md p-1 text-[hsl(var(--sidebar-fg))]/42 transition-colors duration-fast',
                                'hover:bg-[hsl(var(--sidebar-bg))] hover:text-[hsl(var(--sidebar-fg))]',
                              )}
                              aria-label={archiveLabel}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleArchive();
                              }}
                            >
                              <ArchiveIcon className="h-3.5 w-3.5" />
                            </button>
                          </TooltipHint>
                        </span>
                      )}
                    </span>
                  </>
                )}
              </div>
            </HoverCardTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent className="surface-panel z-180 rounded-lg border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_48px_-28px_hsl(var(--foreground)/0.38)] backdrop-blur-md animate-in fade-in fill-mode-both duration-normal ease-motion-out">
            <ContextMenuItem icon={<PinIcon className="h-3.5 w-3.5" />} onClick={handleTogglePinned}>
              {session.is_pinned ? '取消置顶' : '置顶'}
            </ContextMenuItem>
            <ContextMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameStart}>
              重命名
            </ContextMenuItem>
            {workingPath && canOpenExplorer ? (
              <ContextMenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={handleOpenInExplorer}>
                在资源管理器中打开
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem icon={<ArchiveIcon className="h-3.5 w-3.5" />} onClick={handleArchive}>
              {archiveLabel}
            </ContextMenuItem>
            <ContextMenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={handleDelete}>
              删除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <HoverCardContent>
          <SessionInfoCard session={latestSession} workingPath={workingPath} />
        </HoverCardContent>
      </HoverCard>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除对话"
        description={`确定要删除“${session.title || '未命名对话'}”吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={onDelete}
      />
    </>
  );
}
