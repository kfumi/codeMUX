import { open } from '@tauri-apps/plugin-dialog';
import { Loader2, MessageSquarePlus, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/utils';
import { createLogger, serializeError } from '../../lib/logger';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { SessionList } from '../session/SessionList';

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
  const projects = useProjectStore((state) => state.projects);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const needsProxy = useSettingsStore((s) => s.getNeedsProxy());
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  const proxyToggling = useSettingsStore((s) => s.proxyToggling);
  const startProxy = useSettingsStore((s) => s.startProxy);
  const stopProxy = useSettingsStore((s) => s.stopProxy);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!projectSearchOpen) {
      return;
    }

    setProjectQuery('');
    const id = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [projectSearchOpen]);

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    const sortedProjects = [...projects].sort((left, right) => right.updated_at.localeCompare(left.updated_at));

    if (!q) {
      return sortedProjects;
    }

    return sortedProjects.filter((project) => {
      const haystack = `${project.name} ${project.path}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [projectQuery, projects]);

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

  const handleSelectProject = (projectId: string) => {
    setActiveProject(projectId);
    onNavigateHome();
    setProjectSearchOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3">
        <button
          onClick={onNewSession}
          className="flex w-full items-center gap-2.5 rounded-md border-[hsl(var(--sidebar-border))]/48 px-3 py-2 text-[13px] font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
        </button>

        <button
          type="button"
          onClick={() => setProjectSearchOpen(true)}
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

      <Dialog open={projectSearchOpen} onOpenChange={setProjectSearchOpen}>
        <DialogContent className="sm:max-w-140 gap-0 overflow-hidden border-border/70 bg-popover p-0 shadow-[0_24px_64px_-40px_hsl(var(--foreground)/0.5)]">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-base font-semibold text-foreground">搜索项目</DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              输入项目名称或路径，快速切换到目标项目。
            </DialogDescription>
          </DialogHeader>
          <div className="border-b border-border/50 px-5 py-4">
            <input
              ref={searchInputRef}
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              placeholder="搜索项目名称或路径"
              className="h-11 w-full rounded-md border border-border/60 bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/68 focus:border-[hsl(var(--primary)/0.42)]"
            />
          </div>
          <div className="max-h-[min(28rem,calc(100vh-10rem))] overflow-auto p-2">
            {filteredProjects.length > 0 ? (
              filteredProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleSelectProject(project.id)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-foreground/76 transition-colors duration-150 hover:bg-muted/46 hover:text-foreground"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/55 bg-background text-muted-foreground">
                    <span className="h-3.5 w-3.5 rounded-sm border border-current/70" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{project.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{project.path}</div>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的项目。</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
