import { ListTodo, MessageSquarePlus, Search, Settings, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';

import { openDialog } from '../../lib/desktopDialogs';
import { createLogger, serializeError } from '../../lib/logger';
import { useShortcutAriaKeyshortcuts, useShortcutHint } from '../../hooks/useShortcutHint';
import { useChatSearchStore } from '../../stores/chatSearchStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { selectAttentionCount, useWorkTaskStore } from '../../stores/workTaskStore';
import type { Project } from '../../types/project';
import { Tooltip, TooltipContent, TooltipHint, TooltipTrigger } from '../ui/tooltip';
import { CompanionSidebarButton } from '../companion/CompanionSidebarButton';
import { SessionList } from '../session/SessionList';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ProjectExplorer } from '../workspace/ProjectExplorer';

const logger = createLogger('Sidebar');

interface SidebarProps {
  onNewSession: () => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectSession: (sessionId: string, projectId: string | null) => void;
  onOpenSettings: () => void;
  onOpenAutomation: () => void;
  onOpenTodoBoard: () => void;
}

export function Sidebar({
  onNewSession,
  onNewSessionInProject,
  onSelectSession,
  onOpenSettings,
  onOpenAutomation,
  onOpenTodoBoard,
}: SidebarProps) {
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const attentionCount = useWorkTaskStore((state) => selectAttentionCount(state.tasks));
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const chatSearchOpen = useChatSearchStore((state) => state.isOpen);
  const setChatSearchOpen = useChatSearchStore((state) => state.setOpen);
  // 搜索框挂在侧边栏里：切到设置页时侧边栏被替换、搜索框随之卸载，
  // 但开合状态在 store 里；不在这里收掉，回到会话视图会凭空弹出搜索框。
  useEffect(() => () => useChatSearchStore.getState().close(), []);

  // 搜索是「搜索聊天或运行命令」的唯一入口，键位直接显示在按钮上
  const searchShortcutHint = useShortcutHint('openSearch');
  const newSessionHint = useShortcutHint('newSession');
  const newSessionAria = useShortcutAriaKeyshortcuts('newSession');
  const searchAria = useShortcutAriaKeyshortcuts('openSearch');
  const settingsHint = useShortcutHint('openSettings');
  const settingsAria = useShortcutAriaKeyshortcuts('openSettings');
  const [explorerProject, setExplorerProject] = useState<Project | null>(null);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // 侧边栏徽章数据：挂载时拉一次待办任务，之后靠事件桥/看板轮询刷新。
  useEffect(() => {
    void useWorkTaskStore.getState().fetchTasks();
  }, []);

  const handleAddProject = async () => {
    try {
      const selected = await openDialog({
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
      <div className="space-y-0 px-3 pb-1.5 pt-11">
        <button
          type="button"
          onClick={onNewSession}
          aria-keyshortcuts={newSessionAria ?? undefined}
          className="group flex w-full items-center gap-2 rounded-md border-[hsl(var(--sidebar-border))]/48 px-2.5 py-1.5 text-sm font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="flex-1 text-left">新对话</span>
          {newSessionHint && (
            <span className="shrink-0 text-ui-caption text-[hsl(var(--sidebar-fg))]/66 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100">
              {newSessionHint}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setChatSearchOpen(true)}
          aria-keyshortcuts={searchAria ?? undefined}
          className="group flex w-full items-center gap-2 rounded-md border-[hsl(var(--sidebar-border))]/48 px-2.5 py-1.5 text-sm font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">搜索</span>
          {searchShortcutHint && (
            <span className="shrink-0 text-ui-caption text-[hsl(var(--sidebar-fg))]/66 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100">
              {searchShortcutHint}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenAutomation}
          className="flex w-full items-center gap-2 rounded-md border-[hsl(var(--sidebar-border))]/48 px-2.5 py-1.5 text-sm font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <Timer className="h-4 w-4" />
          <span className="flex-1 text-left">自动化</span>
        </button>
        <button
          type="button"
          onClick={onOpenTodoBoard}
          className="flex w-full items-center gap-2 rounded-md border-[hsl(var(--sidebar-border))]/48 px-2.5 py-1.5 text-sm font-medium text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]"
        >
          <ListTodo className="h-4 w-4" />
          <span className="flex-1 text-left">待办任务</span>
          {attentionCount > 0 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-destructive-foreground text-ui-caption font-medium">
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          )}
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
            <span className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-ui-caption text-[hsl(var(--sidebar-fg))]/70">
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
        <TooltipHint content={`打开设置${settingsHint ? ` · ${settingsHint}` : ''}`}>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-keyshortcuts={settingsAria ?? undefined}
            className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-[hsl(var(--sidebar-fg))]/86 transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>设置</span>
          </button>
        </TooltipHint>
      </div>

      <ChatSearchDialog
        open={chatSearchOpen}
        onOpenChange={setChatSearchOpen}
        onSelectSession={onSelectSession}
      />
    </div>
  );
}
