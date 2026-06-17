import { open } from '@tauri-apps/plugin-dialog';
import { MessageSquarePlus, Settings } from 'lucide-react';
import { useEffect } from 'react';

import { createLogger, serializeError } from '../../lib/logger';
import { useProjectStore } from '../../stores/projectStore';
import { SessionList } from '../session/SessionList';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  onNewSession,
  onNewSessionInProject,
  onOpenSettings,
}: SidebarProps) {
  const fetchProjects = useProjectStore((state) => state.fetchProjects);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleAddProject = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      });
      if (selected) {
        const path = selected as string;
        const name = path.split(/[/\\]/).pop() || path;
        await useProjectStore.getState().createProject(name, path);
      }
    } catch (error) {
      logger.error('Failed to add project from dialog', undefined, serializeError(error));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-3">
        <button
          onClick={onNewSession}
          className="surface-panel surface-interactive flex w-full items-center gap-2.5 rounded-xl border border-[hsl(var(--sidebar-border))]/70 bg-[hsl(var(--sidebar-bg))]/78 px-3 py-2.5 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/84 shadow-[0_1px_0_0_hsl(var(--foreground)/0.02)] transition-all duration-200 hover:border-[hsl(var(--sidebar-glow))]/18 hover:bg-[hsl(var(--sidebar-accent))]/82 hover:text-[hsl(var(--sidebar-fg))] active:scale-[0.985] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.95,hsl(var(--surface-1))/0.92)]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 scroll-smooth">
        <SessionList onNewSessionInProject={onNewSessionInProject} onAddProject={handleAddProject} />
      </div>

      <div className="border-t border-[hsl(var(--sidebar-border))] p-3">
        <button
          onClick={onOpenSettings}
          className="surface-panel flex w-full rounded-xl border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-bg))]/72 px-3 py-2 text-[13px] text-[hsl(var(--sidebar-fg))]/72 transition-all duration-200 hover:bg-[hsl(var(--sidebar-accent))]/80 hover:text-[hsl(var(--sidebar-fg))] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.86,hsl(var(--surface-1))/0.8)]"
        >
          <span className="flex items-center gap-2.5">
            <Settings className="h-3.5 w-3.5" />
            设置
          </span>
        </button>
      </div>
    </div>
  );
}
