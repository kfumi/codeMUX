import { ArrowLeft, ChevronDown, ChevronRight, FileWarning, Folder, FolderOpen, Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { daemonFacade } from '../../lib/facades/daemon-facade';
import type { FileTreeNode } from '../../lib/workspaceTypes';
import { cn } from '../../lib/utils';
import { NEW_SESSION_DRAFT_SESSION_ID, useNewSessionStore } from '../../stores/newSessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import type { Project } from '../../types/project';
import { FileTypeIcon } from '../assistant-ui/file-type-icon';
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu';
import { TooltipHint } from '../ui/tooltip';
import { ProjectExplorerContextMenu } from './ProjectExplorerContextMenu';
import { hasLoadedChildren } from './projectExplorerTree';

interface ProjectExplorerProps {
  project: Project;
  onBack: () => void;
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query.trim()) return nodes;

  const normalizedQuery = query.trim().toLowerCase();
  return nodes.flatMap((node) => {
    if (node.is_dir) {
      const children = node.children ? filterTree(node.children, normalizedQuery) : [];
      return children.length > 0 || node.name.toLowerCase().includes(normalizedQuery)
        ? [{ ...node, children }]
        : [];
    }

    return node.name.toLowerCase().includes(normalizedQuery) ? [node] : [];
  });
}

function TreeNode({
  node,
  level,
  query,
  projectPath,
  sessionId,
  onOpenFile,
}: {
  node: FileTreeNode;
  level: number;
  query: string;
  projectPath: string;
  sessionId: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(level === 0 && Boolean(query));
  const [children, setChildren] = useState<FileTreeNode[]>(() => node.children ?? []);
  const [childrenLoaded, setChildrenLoaded] = useState(() => hasLoadedChildren(node));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isDirectory = node.is_dir;

  useEffect(() => {
    setChildren(node.children ?? []);
    setChildrenLoaded(hasLoadedChildren(node));
    setLoadError(null);
  }, [node]);

  useEffect(() => {
    if (query) setExpanded(true);
  }, [query]);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await daemonFacade.listDirectory(node.path, 1, projectPath, true);
      setChildren(fetched);
      setChildrenLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [node.path, projectPath]);

  const handleClick = useCallback(() => {
    if (!isDirectory) {
      onOpenFile(node.path);
      return;
    }

    const nextExpanded = !expanded;
    if (nextExpanded && !childrenLoaded) {
      setExpanded(true);
      void loadChildren();
      return;
    }

    setExpanded(nextExpanded);
  }, [children, childrenLoaded, expanded, isDirectory, loadChildren, node, onOpenFile]);

  const showChildArea = expanded && (loading || loadError || children.length > 0);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui-compact transition-colors',
              'text-[hsl(var(--sidebar-fg))]/72 hover:bg-[hsl(var(--sidebar-muted))]/80 hover:text-[hsl(var(--sidebar-fg))]',
            )}
            style={{ paddingLeft: `${level * 14 + 10}px` }}
            onClick={handleClick}
          >
            {isDirectory ? (
              expanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/40" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/40" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {isDirectory ? (
              expanded ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--sidebar-glow))]/72" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--sidebar-fg))]/54" />
              )
            ) : (
              <FileTypeIcon filePath={node.path} className="h-3.5 w-3.5" />
            )}
            <span className="truncate">{node.name}</span>
            {loading && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-[hsl(var(--sidebar-fg))]/35" />}
          </button>
        </ContextMenuTrigger>
        <ProjectExplorerContextMenu
          path={node.path}
          projectPath={projectPath}
          isDirectory={isDirectory}
          sessionId={sessionId}
          onOpen={handleClick}
        />
      </ContextMenu>
      {showChildArea && (
        <div>
          {loading && children.length === 0 ? (
            <div
              className="flex items-center gap-1.5 px-2 py-1 text-ui-micro text-[hsl(var(--sidebar-fg))]/38"
              style={{ paddingLeft: `${(level + 1) * 14 + 10}px` }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              加载中
            </div>
          ) : loadError ? (
            <div
              className="px-2 py-1 text-ui-micro text-[hsl(var(--destructive))]/75"
              style={{ paddingLeft: `${(level + 1) * 14 + 10}px` }}
            >
              {loadError}
            </div>
          ) : (
            children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                level={level + 1}
                query={query}
                projectPath={projectPath}
                sessionId={sessionId}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectExplorer({ project, onBack }: ProjectExplorerProps) {
  const [nodes, setNodes] = useState<FileTreeNode[]>([]);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openFileTab = useSidePanelStore((state) => state.openFileTab);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const isDraftOpen = useNewSessionStore((state) => state.isDraftOpen);
  const composerSessionId = activeSessionId ?? (isDraftOpen ? NEW_SESSION_DRAFT_SESSION_ID : null);

  const loadTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextNodes = await daemonFacade.listDirectory(project.path, 5, project.path, true);
      setNodes(nextNodes);
    } catch (loadError) {
      setNodes([]);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [project.path]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const visibleNodes = useMemo(() => filterTree(nodes, query), [nodes, query]);

  const handleOpenFile = useCallback(
    (path: string) => {
      void openFileTab(project.path, path);
    },
    [openFileTab, project.path],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[hsl(var(--sidebar-bg))] pt-10">
      <div className="flex shrink-0 items-center gap-1 border-b border-[hsl(var(--sidebar-border))]/45 px-2 py-2">
        <TooltipHint content="返回任务">
          <button
            type="button"
            aria-label="返回任务"
            onClick={onBack}
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[hsl(var(--sidebar-fg))]/70 transition-colors hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="truncate text-ui-title font-medium">返回任务</span>
          </button>
        </TooltipHint>
        <TooltipHint content="刷新文件树">
          <button
            type="button"
            aria-label="刷新文件树"
            onClick={() => void loadTree()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[hsl(var(--sidebar-fg))]/45 transition-colors hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </TooltipHint>
      </div>

      <div className="border-b border-[hsl(var(--sidebar-border))]/35 px-2.5 py-2">
        <label className="flex h-7 items-center gap-2 rounded-md border border-[hsl(var(--sidebar-border))]/60 bg-[hsl(var(--sidebar-muted))]/45 px-2 text-[hsl(var(--sidebar-fg))]/45 focus-within:border-[hsl(var(--sidebar-glow))]/45">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件..."
            className="min-w-0 flex-1 bg-transparent text-ui-compact text-[hsl(var(--sidebar-fg))]/82 outline-none placeholder:text-[hsl(var(--sidebar-fg))]/38"
          />
        </label>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 text-ui-caption text-[hsl(var(--sidebar-fg))]/45">
        <span className="truncate font-medium">{project.name}</span>
        <span className="ml-auto font-mono text-[hsl(var(--sidebar-fg))]/30">{nodes.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-ui-caption text-[hsl(var(--sidebar-fg))]/42">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            正在加载文件树
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-5 py-8 text-center text-ui-caption text-[hsl(var(--sidebar-fg))]/48">
            <FileWarning className="h-5 w-5 text-[hsl(var(--destructive))]/75" />
            <span>文件树加载失败</span>
            <span className="break-all text-ui-micro text-[hsl(var(--sidebar-fg))]/35">{error}</span>
            <button
              type="button"
              onClick={() => void loadTree()}
              className="rounded-md border border-[hsl(var(--sidebar-border))]/65 px-2.5 py-1 text-ui-caption transition-colors hover:bg-[hsl(var(--sidebar-muted))]"
            >
              重试
            </button>
          </div>
        ) : visibleNodes.length === 0 ? (
          <div className="px-5 py-8 text-center text-ui-caption text-[hsl(var(--sidebar-fg))]/42">
            {query ? '没有匹配的文件' : '项目中没有可显示的文件'}
          </div>
        ) : (
          visibleNodes.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              level={0}
              query={query}
              projectPath={project.path}
              sessionId={composerSessionId}
              onOpenFile={handleOpenFile}
            />
          ))
        )}
      </div>

      <div className="shrink-0 truncate border-t border-[hsl(var(--sidebar-border))]/35 px-3 py-2 text-ui-micro text-[hsl(var(--sidebar-fg))]/32" title={project.path}>
        {project.path}
      </div>
    </div>
  );
}
