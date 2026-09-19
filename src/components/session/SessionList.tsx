import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, MessageSquarePlus, Plus } from 'lucide-react';

import type { Project } from '../../types/project';
import { getDaemonStartupError, initDaemonClient } from '../../lib/daemon-bootstrap';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { ImportSessionsDialog } from '../layout/ImportSessionsDialog';
import { ProjectGroup } from './ProjectGroup';
import { SessionItem } from './SessionItem';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

interface SessionListProps {
  onNewSessionInProject: (projectId: string) => void;
  onOpenProjectFiles?: (project: import('../../types/project').Project) => void;
  onAddProject: () => void;
  onSelectSession: (sessionId: string, projectId: string | null) => void;
}

const PROJECTS_SECTION_KEY = 'codemux-projects-section-expanded';
const CONVERSATIONS_SECTION_KEY = 'codemux-conversations-section-expanded';
const PINNED_SECTION_KEY = 'codemux-pinned-section-expanded';

function loadSectionExpanded(storageKey: string): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === 'false') return false;
  } catch {
    // Ignore storage errors and fall back to expanded.
  }
  return true;
}

function saveSectionExpanded(storageKey: string, expanded: boolean): void {
  try {
    localStorage.setItem(storageKey, String(expanded));
  } catch {
    // Ignore storage errors.
  }
}

function SectionHeader({
  title,
  expanded,
  toggleLabel,
  onToggle,
  actions,
}: {
  title: string;
  expanded: boolean;
  toggleLabel: string;
  onToggle: () => void;
  actions?: ReactNode;
}) {

  const isNarrow = useIsNarrowViewport();

  return (
    <div className="group flex items-center gap-1 px-0 py-0.5">
      <button
        type="button"
        aria-label={toggleLabel}
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-[hsl(var(--sidebar-muted))]/70"
      >
        <span className="min-w-0 truncate text-sm font-medium text-[hsl(var(--sidebar-fg))]">
          {title}
        </span>
        {/* 展开/收起箭头跟在标题右侧,悬停该行才出现;窄屏(触摸)没有 hover,常显。 */}
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[hsl(var(--sidebar-fg))]/70 transition-all duration-200',
            isNarrow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {actions}
    </div>
  );
}

export function SessionList({
  onNewSessionInProject,
  onOpenProjectFiles = () => {},
  onAddProject,
  onSelectSession,
}: SessionListProps) {
  // 工单 02:添加项目依赖壳的原生目录选择框,浏览器/移动形态隐藏入口而不是
  // 让用户点到一个必然报错的按钮。
  const canPickDirectory = useHostCapabilities().has('dialog.directory');
  const {
    sessions,
    activeSessionId,
    error: sessionError,
    isLoading,
    fetchSessions,
    fetchArchivedSessions,
    archiveSession,
    setSessionPinned,
    deleteSession,
    updateSessionTitle,
  } = useSessionStore();
  const { projects, activeProjectId, fetchProjects, deleteProject, renameProject } = useProjectStore();
  const { status: companionStatus } = useCompanionStatus({ pollIntervalMs: 15_000, polling: true });
  const [pinnedExpanded, setPinnedExpanded] = useState(() => loadSectionExpanded(PINNED_SECTION_KEY));
  const [projectsExpanded, setProjectsExpanded] = useState(() => loadSectionExpanded(PROJECTS_SECTION_KEY));
  const [conversationsExpanded, setConversationsExpanded] = useState(() => loadSectionExpanded(CONVERSATIONS_SECTION_KEY));
  const [importProject, setImportProject] = useState<Project | null>(null);

  useEffect(() => {
    fetchSessions();
    fetchArchivedSessions();
    fetchProjects();
  }, [fetchSessions, fetchArchivedSessions, fetchProjects]);

  const projectSessions = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (!session.project_id || session.is_pinned) continue;
      const list = map.get(session.project_id) || [];
      list.push(session);
      map.set(session.project_id, list);
    }
    return map;
  }, [sessions]);

  const pinnedSessions = useMemo(() => sessions.filter((session) => session.is_pinned), [sessions]);
  const ungroupedSessions = useMemo(() => sessions.filter((session) => !session.project_id && !session.is_pinned), [sessions]);

  const daemonIssue = useMemo(() => {
    const startupError = getDaemonStartupError();
    if (startupError) return startupError;
    if (companionStatus?.daemonError) return companionStatus.daemonError;
    if (companionStatus && !companionStatus.daemonReady) {
      return '本机 Daemon 未就绪，请稍后重试或重启应用。';
    }
    return sessionError;
  }, [companionStatus, sessionError]);

  const showDaemonIssue = Boolean(daemonIssue) && !isLoading;

  const toggleProjectsExpanded = useCallback(() => {
    setProjectsExpanded((current) => {
      const next = !current;
      saveSectionExpanded(PROJECTS_SECTION_KEY, next);
      return next;
    });
  }, []);

  const togglePinnedExpanded = useCallback(() => {
    setPinnedExpanded((current) => {
      const next = !current;
      saveSectionExpanded(PINNED_SECTION_KEY, next);
      return next;
    });
  }, []);

  const toggleConversationsExpanded = useCallback(() => {
    setConversationsExpanded((current) => {
      const next = !current;
      saveSectionExpanded(CONVERSATIONS_SECTION_KEY, next);
      return next;
    });
  }, []);

  const handleOpenImportSessions = useCallback((project: Project) => {
    setImportProject(project);
  }, []);

  const handleImportDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setImportProject(null);
    }
  }, []);

  const handleRetryDaemon = useCallback(async () => {
    daemonFacade.resetClient();
    await initDaemonClient();
    await fetchSessions();
  }, [fetchSessions]);

  return (
    <div className="space-y-1 stagger-children">
      {showDaemonIssue && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-caption leading-relaxed text-destructive"
        >
          <p>{daemonIssue}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void handleRetryDaemon()}
          >
            重试连接 Daemon
          </Button>
        </div>
      )}
      {pinnedSessions.length > 0 && (
        <div className="space-y-1">
          <SectionHeader
            title="置顶"
            expanded={pinnedExpanded}
            toggleLabel="toggle-pinned-section"
            onToggle={togglePinnedExpanded}
          />
          {pinnedExpanded && pinnedSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => {
                onSelectSession(session.id, session.project_id ?? null);
              }}
              onTogglePinned={(pinned) => void setSessionPinned(session.id, pinned)}
              onArchive={() => archiveSession(session.id)}
              onDelete={() => deleteSession(session.id)}
              onRename={(title) => updateSessionTitle(session.id, title, { titleLocked: true })}
            />
          ))}
        </div>
      )}

      {projects.length > 0 && (
        <div>
          <SectionHeader
            title="项目"
            expanded={projectsExpanded}
            toggleLabel="toggle-projects-section"
            onToggle={toggleProjectsExpanded}
            actions={canPickDirectory ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/86 transition-colors hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
                    onClick={onAddProject}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right"><p>添加项目</p></TooltipContent>
              </Tooltip>
            ) : null}
          />

          {projectsExpanded && projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              sessions={projectSessions.get(project.id) || []}
              activeSessionId={activeSessionId}
              isActiveProject={project.id === activeProjectId}
              onSelectSession={(id) => {
                onSelectSession(id, project.id);
              }}
              onArchiveSession={archiveSession}
              onToggleSessionPinned={(sessionId, pinned) => void setSessionPinned(sessionId, pinned)}
              onDeleteSession={deleteSession}
              onRenameSession={(sessionId, title) => updateSessionTitle(sessionId, title, { titleLocked: true })}
              onNewSessionInProject={onNewSessionInProject}
              onOpenProjectFiles={onOpenProjectFiles}
              onOpenImportSessions={handleOpenImportSessions}
              onDeleteProject={deleteProject}
              onRenameProject={renameProject}
            />
          ))}
        </div>
      )}

      {ungroupedSessions.length > 0 && (
        <div className="space-y-1">
          <SectionHeader
            title="对话"
            expanded={conversationsExpanded}
            toggleLabel="toggle-conversations-section"
            onToggle={toggleConversationsExpanded}
          />
          {conversationsExpanded && ungroupedSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => {
                onSelectSession(session.id, null);
              }}
              onTogglePinned={(pinned) => void setSessionPinned(session.id, pinned)}
              onArchive={() => archiveSession(session.id)}
              onDelete={() => deleteSession(session.id)}
              onRename={(title) => updateSessionTitle(session.id, title, { titleLocked: true })}
            />
          ))}
        </div>
      )}

      {sessions.length === 0 && projects.length === 0 && !showDaemonIssue && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent))]/18 text-[hsl(var(--sidebar-accent))]">
            <MessageSquarePlus className="h-4 w-4" />
          </div>
          <p className="text-ui-compact leading-relaxed text-[hsl(var(--sidebar-fg))]/70">
            暂无对话
            <br />
            <span className="text-ui-caption">点击上方新建</span>
          </p>
          {canPickDirectory && (
            <button
              type="button"
              onClick={onAddProject}
              className="mt-4 flex items-center gap-2 rounded-lg border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/70 px-3 py-1.5 text-ui-compact text-[hsl(var(--sidebar-fg))]/70 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/86 hover:text-[hsl(var(--sidebar-fg))]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加项目
            </button>
          )}
        </div>
      )}

      {canPickDirectory && projects.length === 0 && sessions.length > 0 && (
        <button
          type="button"
          onClick={onAddProject}
          className="mt-1 flex w-full items-center gap-2.5 rounded-lg border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/70 px-2.5 py-1.75 text-ui-compact text-[hsl(var(--sidebar-fg))]/70 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/86 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加项目
        </button>
      )}
      {importProject && (
        <ImportSessionsDialog
          open
          onOpenChange={handleImportDialogOpenChange}
          projectId={importProject.id}
          projectPath={importProject.path}
          projectName={importProject.name}
        />
      )}
    </div>
  );
}
