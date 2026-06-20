import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus, Plus } from 'lucide-react';

import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectGroup } from './ProjectGroup';
import { SessionItem } from './SessionItem';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface SessionListProps {
  onNewSessionInProject: (projectId: string) => void;
  onAddProject: () => void;
}

export function SessionList({ onNewSessionInProject, onAddProject }: SessionListProps) {
  const {
    sessions,
    activeSessionId,
    fetchSessions,
    fetchArchivedSessions,
    setActiveSession,
    archiveSession,
    deleteSession,
    updateSessionTitle,
  } = useSessionStore();
  const { projects, activeProjectId, fetchProjects, deleteProject, renameProject, setActiveProject } = useProjectStore();
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenuSessionId(null), []);

  useEffect(() => {
    if (!menuSessionId) return;
    const close = () => setMenuSessionId(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menuSessionId]);

  useEffect(() => {
    fetchSessions();
    fetchArchivedSessions();
    fetchProjects();
  }, [fetchSessions, fetchArchivedSessions, fetchProjects]);

  const projectSessions = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (!session.project_id) continue;
      const list = map.get(session.project_id) || [];
      list.push(session);
      map.set(session.project_id, list);
    }
    return map;
  }, [sessions]);

  const ungroupedSessions = useMemo(() => sessions.filter((session) => !session.project_id), [sessions]);

  return (
    <div className="space-y-2 stagger-children">
      {projects.length > 0 && (
        <div>
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-normal text-[hsl(var(--sidebar-fg))]/38">
              项目
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/50 transition-colors hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
                  onClick={onAddProject}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right"><p>添加项目</p></TooltipContent>
            </Tooltip>
          </div>

          {projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              sessions={projectSessions.get(project.id) || []}
              activeSessionId={activeSessionId}
              isActiveProject={project.id === activeProjectId}
              onSelectSession={(id) => {
                setActiveProject(project.id);
                setActiveSession(id);
              }}
              onArchiveSession={archiveSession}
              onDeleteSession={deleteSession}
              onRenameSession={updateSessionTitle}
              onNewSessionInProject={onNewSessionInProject}
              onDeleteProject={deleteProject}
              onRenameProject={renameProject}
              menuSessionId={menuSessionId}
              onOpenMenu={setMenuSessionId}
              onCloseMenu={closeMenu}
            />
          ))}
        </div>
      )}

      {ungroupedSessions.length > 0 && (
        <div>
          {projects.length > 0 && (
            <div className="px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-normal text-[hsl(var(--sidebar-fg))]/38">
                对话
              </span>
            </div>
          )}
          {ungroupedSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => {
                setActiveProject(null);
                setActiveSession(session.id);
              }}
              onArchive={() => archiveSession(session.id)}
              onDelete={() => deleteSession(session.id)}
              onRename={(title) => updateSessionTitle(session.id, title)}
              isMenuOpen={menuSessionId === session.id}
              onOpenMenu={() => setMenuSessionId(session.id)}
              onCloseMenu={closeMenu}
            />
          ))}
        </div>
      )}

      {sessions.length === 0 && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent))]/18 text-[hsl(var(--sidebar-accent))]">
            <MessageSquarePlus className="h-4 w-4" />
          </div>
          <p className="text-[12px] leading-relaxed text-[hsl(var(--sidebar-fg))]/50">
            暂无对话
            <br />
            <span className="text-[11px]">点击上方新建</span>
          </p>
        </div>
      )}

      {projects.length === 0 && sessions.length > 0 && (
        <button
          onClick={onAddProject}
          className="mt-1 flex w-full items-center gap-2.5 rounded-lg border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/70 px-2.5 py-1.75 text-[12px] text-[hsl(var(--sidebar-fg))]/56 transition-all duration-200 hover:bg-[hsl(var(--sidebar-muted))]/86 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加项目
        </button>
      )}
    </div>
  );
}
