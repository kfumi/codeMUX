import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, MessageSquarePlus, Plus } from 'lucide-react';

import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectGroup } from './ProjectGroup';
import { SessionItem } from './SessionItem';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';

interface SessionListProps {
  onNewSessionInProject: (projectId: string) => void;
  onAddProject: () => void;
  onNavigateHome: () => void;
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
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <button
        type="button"
        aria-label={toggleLabel}
        aria-expanded={expanded}
        onClick={onToggle}
        className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[hsl(var(--sidebar-muted))]/70"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[hsl(var(--sidebar-fg))]/42 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
        <span className="text-ui-caption font-semibold uppercase tracking-normal text-[hsl(var(--sidebar-fg))]/38">
          {title}
        </span>
      </button>
      {actions}
    </div>
  );
}

export function SessionList({ onNewSessionInProject, onAddProject, onNavigateHome }: SessionListProps) {
  const {
    sessions,
    activeSessionId,
    fetchSessions,
    fetchArchivedSessions,
    setActiveSession,
    archiveSession,
    setSessionPinned,
    deleteSession,
    updateSessionTitle,
  } = useSessionStore();
  const { projects, activeProjectId, fetchProjects, deleteProject, renameProject, setActiveProject } = useProjectStore();
  const [pinnedExpanded, setPinnedExpanded] = useState(() => loadSectionExpanded(PINNED_SECTION_KEY));
  const [projectsExpanded, setProjectsExpanded] = useState(() => loadSectionExpanded(PROJECTS_SECTION_KEY));
  const [conversationsExpanded, setConversationsExpanded] = useState(() => loadSectionExpanded(CONVERSATIONS_SECTION_KEY));

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

  return (
    <div className="space-y-2 stagger-children">
      {pinnedSessions.length > 0 && (
        <div>
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
                onNavigateHome();
                setActiveProject(session.project_id ?? null);
                setActiveSession(session.id);
              }}
              onTogglePinned={(pinned) => void setSessionPinned(session.id, pinned)}
              onArchive={() => archiveSession(session.id)}
              onDelete={() => deleteSession(session.id)}
              onRename={(title) => updateSessionTitle(session.id, title)}
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
            actions={(
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/50 transition-colors hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
                    onClick={onAddProject}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right"><p>添加项目</p></TooltipContent>
              </Tooltip>
            )}
          />

          {projectsExpanded && projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              sessions={projectSessions.get(project.id) || []}
              activeSessionId={activeSessionId}
              isActiveProject={project.id === activeProjectId}
              onSelectSession={(id) => {
                onNavigateHome();
                setActiveProject(project.id);
                setActiveSession(id);
              }}
              onArchiveSession={archiveSession}
              onToggleSessionPinned={(sessionId, pinned) => void setSessionPinned(sessionId, pinned)}
              onDeleteSession={deleteSession}
              onRenameSession={updateSessionTitle}
              onNewSessionInProject={onNewSessionInProject}
              onDeleteProject={deleteProject}
              onRenameProject={renameProject}
            />
          ))}
        </div>
      )}

      {ungroupedSessions.length > 0 && (
        <div>
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
                onNavigateHome();
                setActiveProject(null);
                setActiveSession(session.id);
              }}
              onTogglePinned={(pinned) => void setSessionPinned(session.id, pinned)}
              onArchive={() => archiveSession(session.id)}
              onDelete={() => deleteSession(session.id)}
              onRename={(title) => updateSessionTitle(session.id, title)}
            />
          ))}
        </div>
      )}

      {sessions.length === 0 && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent))]/18 text-[hsl(var(--sidebar-accent))]">
            <MessageSquarePlus className="h-4 w-4" />
          </div>
          <p className="text-ui-compact leading-relaxed text-[hsl(var(--sidebar-fg))]/50">
            暂无对话
            <br />
            <span className="text-ui-caption">点击上方新建</span>
          </p>
          <button
            type="button"
            onClick={onAddProject}
            className="mt-4 flex items-center gap-2 rounded-lg border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/70 px-3 py-1.5 text-ui-compact text-[hsl(var(--sidebar-fg))]/56 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/86 hover:text-[hsl(var(--sidebar-fg))]"
          >
            <Plus className="h-3.5 w-3.5" />
            添加项目
          </button>
        </div>
      )}

      {projects.length === 0 && sessions.length > 0 && (
        <button
          type="button"
          onClick={onAddProject}
          className="mt-1 flex w-full items-center gap-2.5 rounded-lg border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/70 px-2.5 py-1.75 text-ui-compact text-[hsl(var(--sidebar-fg))]/56 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/86 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加项目
        </button>
      )}
    </div>
  );
}
