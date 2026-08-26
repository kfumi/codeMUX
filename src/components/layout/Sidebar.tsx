import { open } from '@tauri-apps/plugin-dialog';
import { Download, MessageSquarePlus, Search, Settings, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createLogger, serializeError } from '../../lib/logger';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Project } from '../../types/project';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { CompanionSidebarButton } from '../companion/CompanionSidebarButton';
import { SessionList } from '../session/SessionList';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ImportSessionsDialog } from './ImportSessionsDialog';
import { ProjectExplorer } from '../workspace/ProjectExplorer';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onNavigateHome: () => void;
  onSelectSession: (sessionId: string, projectId: string | null) => void;
  onOpenSettings: () => void;
  onOpenAutomation: () => void;
}

export function Sidebar({
  onNewSession,
  onNewSessionInProject,
  onNavigateHome,
  onSelectSession,
  onOpenSettings,
  onOpenAutomation,
}: SidebarProps) {
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [explorerProject, setExplorerProject] = useState<Project | null>(null);

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

  if (explorerProject) {
    return (
      <ProjectExplorer
        project={explorerProject}
        onBack={() => setExplorerProject(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 px-3 pb-2 pt-11">
        <button
          onClick={onNewSession}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-ui-title font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>

        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-ui-title font-medium text-[hsl(var(--sidebar-fg))]/72 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Download className="h-4 w-4" />
          <span className="flex-1 text-left">导入外部会话</span>
        </button>

        <button
          type="button"
          onClick={() => setChatSearchOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-ui-title font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">搜索</span>
        </button>

        <button
          type="button"
          onClick={onOpenAutomation}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-ui-title font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Timer className="h-4 w-4" />
          <span className="flex-1 text-left">自动化</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 scroll-smooth">
        <SessionList
          onNewSessionInProject={onNewSessionInProject}
          onOpenProjectFiles={setExplorerProject}
          onAddProject={handleAddProject}
          onSelectSession={onSelectSession}
        />
      </div>

      <div className="flex items-center gap-1 border-t border-[hsl(var(--sidebar-border))]/45 px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-ui-caption text-[hsl(var(--sidebar-fg))]/50">
              <span className={proxyRunning ? 'inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--success))]' : 'inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--sidebar-fg))]/30'} />
              <span>{proxyRunning ? `Proxy :${port ?? '...'}` : 'Proxy'}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {proxyRunning ? `由当前 Codex 会话自动运行 (${proxyUrl})` : '由 Codex 档案在会话启动时按需运行'}
            </p>
          </TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <CompanionSidebarButton />
        <button
          onClick={onOpenSettings}
          className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-ui-title text-[hsl(var(--sidebar-fg))]/66 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Settings className="h-3.5 w-3.5" />
          <span>设置</span>
        </button>
      </div>

      <ChatSearchDialog
        open={chatSearchOpen}
        onOpenChange={setChatSearchOpen}
        onSelectSession={onSelectSession}
      />
      <ImportSessionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onNavigateHome}
      />
    </div>
  );
}
