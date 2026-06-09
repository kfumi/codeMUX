import { useEffect } from 'react';
import { SessionList } from '../session/SessionList';
import { Settings, MessageSquarePlus, PanelLeftClose } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { open } from '@tauri-apps/plugin-dialog';
import { createLogger, serializeError } from '../../lib/logger';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onToggleCollapse?: () => void;
}

export function Sidebar({ onNewSession, onNewSessionInProject, onOpenSettings, onToggleCollapse }: SidebarProps) {
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
    <div className="flex flex-col h-full">
      {/* New session button + collapse */}
      <div className="px-3 pt-2 pb-2.5 flex items-center gap-1">
        <button
          onClick={onNewSession}
          className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium
            text-[hsl(var(--sidebar-fg))]/80
            hover:text-[hsl(var(--sidebar-glow))]
            hover:bg-[hsl(var(--sidebar-glow)/0.06)]
            hover:shadow-[inset_0_0_0_1px_hsl(var(--sidebar-glow)/0.1)]
            active:scale-[0.98]
            transition-all duration-200"
        >
          <MessageSquarePlus className="h-4 w-4" />
          新对话
        </button>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg text-[hsl(var(--sidebar-fg))]/40
              hover:text-[hsl(var(--sidebar-glow))]
              hover:bg-[hsl(var(--sidebar-glow)/0.06)]
              transition-all duration-200 shrink-0"
            title="收起侧边栏"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-auto px-3 scroll-smooth">
        <SessionList
          onNewSessionInProject={onNewSessionInProject}
          onAddProject={handleAddProject}
        />
      </div>

      {/* Bottom settings */}
      <div className="p-3 border-t border-[hsl(var(--sidebar-border))]">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px]
            text-[hsl(var(--sidebar-fg))]/70
            hover:text-[hsl(var(--sidebar-fg))]
            hover:bg-[hsl(var(--sidebar-accent))]
            transition-all duration-200"
        >
          <Settings className="h-3.5 w-3.5" />
          设置
        </button>
      </div>
    </div>
  );
}
