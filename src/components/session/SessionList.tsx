import { useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { SessionItem } from './SessionItem';
import { ProjectGroup } from './ProjectGroup';
import { Plus, MessageSquarePlus } from 'lucide-react';

interface SessionListProps {
  onNewSessionInProject: (projectId: string) => void;
  onAddProject: () => void;
}

export function SessionList({ onNewSessionInProject, onAddProject }: SessionListProps) {
  const { sessions, activeSessionId, fetchSessions, setActiveSession, deleteSession } = useSessionStore();
  const { projects, activeProjectId, fetchProjects, deleteProject, renameProject, setActiveProject } = useProjectStore();

  useEffect(() => {
    fetchSessions();
    fetchProjects();
  }, [fetchSessions, fetchProjects]);

  const projectSessions = new Map<string, typeof sessions>();
  const ungroupedSessions: typeof sessions = [];

  for (const session of sessions) {
    if (session.project_id) {
      const list = projectSessions.get(session.project_id) || [];
      list.push(session);
      projectSessions.set(session.project_id, list);
    } else {
      ungroupedSessions.push(session);
    }
  }

  return (
    <div className="space-y-2 stagger-children">
      {/* Projects section */}
      {projects.length > 0 && (
        <div>
          <div className="flex items-center justify-between px-2.5 py-1.5 mb-0.5">
            <span
              className="text-[12px] font-semibold tracking-wide text-[hsl(var(--sidebar-fg))]/30"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              项目
            </span>
            <button
              className="p-0.5 rounded hover:bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-fg))]/60 hover:text-[hsl(var(--sidebar-fg))] transition-all duration-200"
              onClick={onAddProject}
              title="添加项目"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              sessions={projectSessions.get(project.id) || []}
              activeSessionId={activeSessionId}
              isActiveProject={project.id === activeProjectId}
              onSelectSession={(id) => { setActiveProject(project.id); setActiveSession(id); }}
              onDeleteSession={deleteSession}
              onNewSessionInProject={onNewSessionInProject}
              onDeleteProject={deleteProject}
              onRenameProject={renameProject}
            />
          ))}
        </div>
      )}

      {/* Ungrouped sessions */}
      {ungroupedSessions.length > 0 && (
        <div>
          {projects.length > 0 && (
            <div className="px-2.5 py-1.5 mb-0.5">
              <span
                className="text-[12px] font-semibold tracking-wide text-[hsl(var(--sidebar-fg))]/30"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                对话
              </span>
            </div>
          )}
          {ungroupedSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => { setActiveProject(null); setActiveSession(session.id); }}
              onDelete={() => deleteSession(session.id)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {sessions.length === 0 && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-8 h-8 rounded-lg bg-[hsl(var(--sidebar-accent))] flex items-center justify-center mb-3">
            <MessageSquarePlus className="h-4 w-4 text-[hsl(var(--sidebar-fg))]/60" />
          </div>
          <p className="text-[12px] text-[hsl(var(--sidebar-fg))]/50 leading-relaxed">
            暂无对话<br />
            <span className="text-[11px]">点击上方开始</span>
          </p>
        </div>
      )}

      {/* Add project button when no projects */}
      {projects.length === 0 && sessions.length > 0 && (
        <button
          onClick={onAddProject}
          className="w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-md text-[12px]
            text-[hsl(var(--sidebar-fg))]/50
            hover:text-[hsl(var(--sidebar-fg))]
            hover:bg-[hsl(var(--sidebar-accent))]
            transition-all duration-200 mt-1"
        >
          <Plus className="h-3.5 w-3.5" />
          添加项目
        </button>
      )}
    </div>
  );
}
