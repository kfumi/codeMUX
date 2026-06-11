import { open } from '@tauri-apps/plugin-dialog';
import { MessageSquarePlus, PanelLeftClose, Settings } from 'lucide-react';
import { useEffect } from 'react';

import { createLogger, serializeError } from '../../lib/logger';
import { useProjectStore } from '../../stores/projectStore';
import { SessionList } from '../session/SessionList';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onToggleCollapse?: () => void;
}

export function Sidebar({
  onNewSession,
  onNewSessionInProject,
  onOpenSettings,
  onToggleCollapse,
}: SidebarProps) {
  const { fetchProjects } = useProjectStore();

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
    } catch (err) {
      logger.error('Failed to add project from dialog', undefined, serializeError(err));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2.5 pt-2">
        <button
          onClick={onNewSession}
          className="flex flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/80 transition-all duration-200 hover:bg-[hsl(var(--sidebar-glow)/0.06)] hover:text-[hsl(var(--sidebar-glow))] hover:shadow-[inset_0_0_0_1px_hsl(var(--sidebar-glow)/0.1)] active:scale-[0.98]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="shrink-0 rounded-lg p-1.5 text-[hsl(var(--sidebar-fg))]/40 transition-all duration-200 hover:bg-[hsl(var(--sidebar-glow)/0.06)] hover:text-[hsl(var(--sidebar-glow))]"
            title="收起侧边栏"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-3 scroll-smooth">
        <SessionList
          onNewSessionInProject={onNewSessionInProject}
          onAddProject={handleAddProject}
        />
      </div>

      <div className="border-t border-[hsl(var(--sidebar-border))] p-3">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-xl px-3 py-2 text-[13px] text-[hsl(var(--sidebar-fg))]/70 transition-all duration-200 hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-fg))]"
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
