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
      <div className="px-2.5 pb-2.5 pt-2.5">
        <button
          onClick={onNewSession}
          className="flex w-full items-center gap-2.5 rounded-lg border border-[hsl(var(--sidebar-border))]/82 bg-[hsl(var(--surface-2))]/72 px-3 py-2 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/86 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)] transition-all duration-200 hover:border-[hsl(var(--sidebar-glow))]/30 hover:bg-[hsl(var(--sidebar-muted))]/88 hover:text-[hsl(var(--sidebar-fg))] active:scale-[0.99]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto px-2.5 pb-3 scroll-smooth">
        <SessionList onNewSessionInProject={onNewSessionInProject} onAddProject={handleAddProject} />
      </div>

      <div className="border-t border-[hsl(var(--sidebar-border))] p-2.5">
        <button
          onClick={onOpenSettings}
          className="flex w-full rounded-lg border border-transparent bg-transparent px-3 py-2 text-[13px] text-[hsl(var(--sidebar-fg))]/66 transition-all duration-200 hover:border-[hsl(var(--sidebar-border))]/70 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]"
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
