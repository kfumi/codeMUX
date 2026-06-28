import { open } from '@tauri-apps/plugin-dialog';
import { Loader2, MessageSquarePlus, Search, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../../lib/utils';
import { createLogger, serializeError } from '../../lib/logger';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SessionList } from '../session/SessionList';
import { ChatSearchDialog } from './ChatSearchDialog';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onNavigateHome: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  onNewSession,
  onNewSessionInProject,
  onNavigateHome,
  onOpenSettings,
}: SidebarProps) {
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const needsProxy = useSettingsStore((s) => s.getNeedsProxy());
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  const proxyToggling = useSettingsStore((s) => s.proxyToggling);
  const startProxy = useSettingsStore((s) => s.startProxy);
  const stopProxy = useSettingsStore((s) => s.stopProxy);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const [chatSearchOpen, setChatSearchOpen] = useState(false);

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
      <div className="space-y-1 px-3 pb-2 pt-11">
        <button
          onClick={onNewSession}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>

        <button
          type="button"
          onClick={() => setChatSearchOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">搜索</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 scroll-smooth">
        <SessionList onNewSessionInProject={onNewSessionInProject} onAddProject={handleAddProject} onNavigateHome={onNavigateHome} />
      </div>

      <div className="flex items-center gap-1 border-t border-[hsl(var(--sidebar-border))]/45 px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void (proxyRunning ? stopProxy() : startProxy())}
              disabled={proxyToggling || (!needsProxy && !proxyRunning)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-[hsl(var(--sidebar-fg))]/50 transition-colors hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]/80',
                (proxyToggling || (!needsProxy && !proxyRunning)) && 'opacity-50',
              )}
            >
              {proxyToggling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full',
                    proxyRunning ? 'bg-[hsl(var(--success))]' : 'bg-[hsl(var(--sidebar-fg))]/30',
                  )}
                />
              )}
              <span>{proxyRunning ? `Proxy :${port ?? '...'}` : 'Proxy'}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {proxyRunning
                ? `点击停止代理 (${proxyUrl})`
                : needsProxy
                  ? '点击启动代理'
                  : '当前供应商配置不需要路由代理'}
            </p>
          </TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <button
          onClick={onOpenSettings}
          className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-[hsl(var(--sidebar-fg))]/66 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Settings className="h-3.5 w-3.5" />
          <span>设置</span>
        </button>
      </div>

      <ChatSearchDialog
        open={chatSearchOpen}
        onOpenChange={setChatSearchOpen}
        onNavigateHome={onNavigateHome}
      />
    </div>
  );
}
