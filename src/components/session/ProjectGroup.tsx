import { useState } from 'react';
import { shellFacade } from '../../lib/facades/shell-facade';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, ChevronUp, Download, Folder, FolderOpen, FolderTree, Folders, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import type { Project } from '../../types/project';
import { getPrimaryProjectRoot } from '../../lib/projectRoot';
import type { ProjectSidebarSection } from '../../lib/sidebarProjection';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { SessionItem } from './SessionItem';
import { ProjectEditorDialog } from './ProjectEditorDialog';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { FoldersOpenIcon } from '../ui/folders-open-icon';
import { cn } from '../../lib/utils';
import { resolveProjectDropPosition } from './projectReorder';

// 与 --motion-duration-normal 对齐；easing 直接用令牌，避免手写曲线。
const PROJECT_SORT_TRANSITION = { duration: 200, easing: 'var(--motion-ease-standard)' };

interface ProjectGroupProps {
  project: Project;
  /** 由侧栏投影一次算好的项目分组：可见行、计数与展开态。 */
  section: ProjectSidebarSection;
  activeSessionId: string | null;
  isActiveProject: boolean;
  onToggleExpanded: () => void;
  onShowMoreSessions: () => void;
  onCollapseSessions: () => void;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onToggleSessionPinned: (sessionId: string, pinned: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onOpenProjectFiles: (project: Project) => void;
  onOpenImportSessions: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  /** 启用侧栏整行拖拽排序；缺省时不注册 sortable（ProjectGroup 仍可独立复用）。 */
  dragEnabled?: boolean;
  /** 键盘 Alt+↑/↓ 平移项目；由列表层负责计算新顺序。 */
  onMoveProject?: (projectId: string, direction: -1 | 1) => void;
}

export function ProjectGroup({
  project,
  section,
  activeSessionId,
  isActiveProject,
  onToggleExpanded,
  onShowMoreSessions,
  onCollapseSessions,
  onSelectSession,
  onArchiveSession,
  onToggleSessionPinned,
  onDeleteSession,
  onRenameSession,
  onNewSessionInProject,
  onOpenProjectFiles,
  onOpenImportSessions,
  onDeleteProject,
  dragEnabled = false,
  onMoveProject,
}: ProjectGroupProps) {
  // 窄屏抽屉没有 hover:项目行操作按钮(更多/文件树/新建对话)常显,否则触屏上
  // 根本点不到;桌面保持 hover 展开不变。资源管理器入口按宿主能力隐藏。
  const isNarrow = useIsNarrowViewport();
  const canOpenExplorer = useHostCapabilities().has('shell.explorer');
  const expanded = section.expanded;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const visibleSessions = section.visibleSessions;
  const hasHiddenSessions = section.hasHiddenSessions;
  const {
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    activeIndex,
    index,
  } = useSortable({
    id: project.id,
    disabled: !dragEnabled,
    transition: PROJECT_SORT_TRANSITION,
  });
  // 落点线跟随 sortable 的 over 项；被拖项自身与无 active 状态不画线。
  const dropPosition = dragEnabled
    ? resolveProjectDropPosition(isOver, isDragging, activeIndex, index)
    : null;
  const canCollapseSessions = section.canCollapseSessions;
  // 多根项目用叠放的文件夹图标区分；展开时换成打开版，单根同样切到 FolderOpen。
  const projectIconClass = cn(
    'h-3.5 w-3.5 shrink-0 transition-colors duration-normal',
    isActiveProject ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64',
  );

  return (
    <div
      ref={setNodeRef}
      data-project-group={project.id}
      style={{
        // 项目高度不一致时 dnd-kit 会缩放活动项；只保留排序位移。
        transform: transform
          ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
          : undefined,
        // 让位动画由 sortable 提供：拖拽中才有过渡，落位时不会二次位移。
        transition,
        position: 'relative',
        zIndex: isDragging ? 10 : dropPosition ? 20 : undefined,
      }}
      className="mb-1"
    >
      <div
        data-project-row={project.id}
        tabIndex={dragEnabled ? 0 : undefined}
        aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        className={cn(
          'group relative flex select-none items-center gap-2 rounded-md border border-transparent px-1.5 py-0.5 text-sm transition-colors duration-fast',
          'text-[hsl(var(--sidebar-fg))]/86 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]',
          'dark:hover:border-[hsl(var(--sidebar-glow))]/14 dark:hover:bg-[hsl(var(--surface-3))]/74',
          isActiveProject && 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--sidebar-fg))] dark:border-[hsl(var(--sidebar-border))]/70 dark:bg-[hsl(var(--foreground)/0.09)]',
          'cursor-pointer',
          dragEnabled && 'touch-none',
          isDragging && 'cursor-grabbing',
        )}
        onClick={onToggleExpanded}
        {...(dragEnabled ? listeners : {})}
        onKeyDown={(event) => {
          if (!dragEnabled || !onMoveProject) return;
          if (!event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMoveProject(project.id, event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        {dropPosition ? (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-[hsl(var(--sidebar-glow))]',
              dropPosition === 'before' ? '-top-px' : '-bottom-px',
            )}
          />
        ) : null}
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/64 transition-transform duration-normal',
            expanded && 'rotate-90',
          )}
        />
        {project.roots.length > 1 ? (
          expanded
            ? <FoldersOpenIcon className={projectIconClass} />
            : <Folders className={projectIconClass} />
        ) : (
          expanded
            ? <FolderOpen className={projectIconClass} />
            : <Folder className={projectIconClass} />
        )}
        <span className="flex-1 truncate text-sm font-medium">{project.name}</span>
        {project.roots.length > 1 ? (
          <span className="sr-only">{project.roots.length} 个源文件夹</span>
        ) : null}
        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity duration-normal',
            isNarrow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`项目 ${project.name} 的更多操作`}
                className="h-6 w-6 rounded-md text-[hsl(var(--sidebar-fg))]/55 hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={<Download className="h-3.5 w-3.5" />}
                onSelect={() => onOpenImportSessions(project)}
              >
                导入外部会话
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Pencil className="h-3.5 w-3.5" />}
                onSelect={() => setEditorOpen(true)}
              >
                编辑项目
              </DropdownMenuItem>
              {canOpenExplorer ? (
                <DropdownMenuItem
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  onClick={() => {
                    const primaryRoot = getPrimaryProjectRoot(project);
                    if (primaryRoot) {
                      shellFacade.openInExplorer(primaryRoot);
                    }
                  }}
                >
                  在资源管理器中打开
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                danger
                onClick={() => window.setTimeout(() => setConfirmOpen(true), 0)}
              >
                移除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`打开项目 ${project.name} 的文件`}
                className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/45 transition-all duration-normal hover:bg-[hsl(var(--sidebar-glow)/0.06)] hover:text-[hsl(var(--sidebar-glow))]"
                onClick={() => onOpenProjectFiles(project)}
              >
                <FolderTree className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>打开项目文件</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/45 transition-all duration-normal hover:bg-[hsl(var(--sidebar-glow)/0.06)] hover:text-[hsl(var(--sidebar-glow))]"
                onClick={() => onNewSessionInProject(project.id)}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>在此项目中创建对话</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
      {expanded && (
        <div
          data-project-sessions={project.id}
          className={cn(
            'ml-2.5 mt-1 space-y-1 pl-1.5',
            section.sessions.length > 0 && 'border-l border-[hsl(var(--sidebar-fg))]/12',
          )}
        >
          {section.sessions.length === 0 ? (
            <p className="px-2.5 py-1 text-ui-compact text-[hsl(var(--sidebar-fg))]/64">
              暂无对话
            </p>
          ) : null}
          {visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
              onTogglePinned={(pinned) => onToggleSessionPinned(session.id, pinned)}
              onArchive={() => onArchiveSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onRename={(title) => onRenameSession(session.id, title)}
            />
          ))}
          {(hasHiddenSessions || canCollapseSessions) && (
            <div className="flex items-center gap-1.5 pt-1">
              {hasHiddenSessions && (
                <button
                  type="button"
                  aria-label={`展开显示项目 ${project.name} 的更多对话`}
                  onClick={onShowMoreSessions}
                  className="flex min-w-0 flex-1 items-center justify-start gap-1 rounded-md px-1.5 py-1 text-ui-compact font-medium text-[hsl(var(--sidebar-fg))]/70 transition-colors hover:bg-[hsl(var(--sidebar-muted))]/72 hover:text-[hsl(var(--sidebar-fg))]/82"
                >
                  <ChevronDown className="h-3 w-3" />
                  展开显示
                </button>
              )}
              {canCollapseSessions && (
                <button
                  type="button"
                  aria-label={`折叠显示项目 ${project.name} 的对话`}
                  onClick={onCollapseSessions}
                  className="flex min-w-0 flex-1 items-center justify-start gap-1 rounded-md px-1.5 py-1 text-ui-compact font-medium text-[hsl(var(--sidebar-fg))]/70 transition-colors hover:bg-[hsl(var(--sidebar-muted))]/72 hover:text-[hsl(var(--sidebar-fg))]/82"
                >
                  <ChevronUp className="h-3 w-3" />
                  折叠显示
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <ProjectEditorDialog
        project={project}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="移除项目"
        description={`确定要移除“${project.name}”吗？其名下 ${section.sessionCount} 条会话会被一并删除。`}
        confirmLabel="移除"
        variant="destructive"
        onConfirm={() => onDeleteProject(project.id)}
      />
    </div>
  );
}
