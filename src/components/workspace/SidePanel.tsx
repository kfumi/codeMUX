import { Bot, ChevronRight, FileSearch, FileCode, FileText, Maximize2, Minimize2, Plus, Terminal, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { readLayoutPreferences, updateLayoutPreferences } from '../../lib/layoutPreferences';
import { LAYOUT_DIVIDER_CLASS } from '../../lib/layoutTokens';
import { cn } from '../../lib/utils';
import { useSidePanelStore, type SidePanelTab } from '../../stores/sidePanelStore';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipHint, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { DiffView } from '../preview/DiffView';
import { PlanPreviewPanel } from './plan/PlanPreviewPanel';
import { ReviewPanel } from './review/ReviewPanel';
import { TerminalPanel } from './terminal/TerminalPanel';
import { FileTypeIcon } from '../assistant-ui/file-type-icon';
import { FileEditorPanel } from './FileEditorPanel';
import { SubagentPreviewPanel } from './SubagentPreviewPanel';

interface SidePanelProps {
  projectPath?: string | null;
  scopeId: string;
  isVisible?: boolean;
}

export function SidePanel({ projectPath, scopeId, isVisible = true }: SidePanelProps) {
  const isOpen = useSidePanelStore((state) => state.isOpen);
  const isExpanded = useSidePanelStore((state) => state.isExpanded);
  const panelWidth = useSidePanelStore((state) => state.panelWidth);
  const isResizing = useSidePanelStore((state) => state.isResizing);
  const tabs = useSidePanelStore((state) => state.tabs);
  const scopes = useSidePanelStore((state) => state.scopes);
  const activeTabId = useSidePanelStore((state) => state.activeTabId);
  const setPanelWidth = useSidePanelStore((state) => state.setPanelWidth);
  const setResizing = useSidePanelStore((state) => state.setResizing);
  const setActiveTab = useSidePanelStore((state) => state.setActiveTab);
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const closeOtherTabs = useSidePanelStore((state) => state.closeOtherTabs);
  const closeAllTabs = useSidePanelStore((state) => state.closeAllTabs);
  const closePanel = useSidePanelStore((state) => state.closePanel);
  const toggleExpanded = useSidePanelStore((state) => state.toggleExpanded);
  const openReviewTab = useSidePanelStore((state) => state.openReviewTab);
  const openTerminalTab = useSidePanelStore((state) => state.openTerminalTab);
  const setScope = useSidePanelStore((state) => state.setScope);
  const draggingRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setScope(scopeId);
  }, [scopeId, setScope]);

  useLayoutEffect(() => {
    const ratio = readLayoutPreferences().sidePanelRatio;
    const splitContainerWidth = panelRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    if (ratio && splitContainerWidth > 0) {
      setPanelWidth(splitContainerWidth * ratio, splitContainerWidth);
    }
  }, [scopeId, setPanelWidth]);

  useLayoutEffect(() => {
    const restorePanelRatio = () => {
      if (draggingRef.current) return;

      const splitContainerWidth = panelRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      const ratio = readLayoutPreferences().sidePanelRatio;
      if (!ratio || splitContainerWidth <= 0) return;

      setPanelWidth(splitContainerWidth * ratio, splitContainerWidth);
    };

    const handleWindowResize = () => {
      window.requestAnimationFrame(restorePanelRatio);
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [setPanelWidth]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, tabs]);
  const terminalTabs = useMemo(() => {
    const allTabs = [
      ...tabs,
      ...Object.values(scopes).flatMap((snapshot) => snapshot.tabs),
    ];
    const seen = new Set<string>();
    return allTabs.filter((tab) => {
      if (tab.kind !== 'terminal' || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
  }, [scopes, tabs]);

  const openReview = useCallback(() => {
    if (projectPath) openReviewTab(projectPath);
  }, [openReviewTab, projectPath]);

  const openTerminal = useCallback(() => {
    if (projectPath) openTerminalTab(projectPath);
  }, [openTerminalTab, projectPath]);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startWidth = panelWidth;
    const splitContainerWidth = panelRef.current?.parentElement?.getBoundingClientRect().width;

    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      setPanelWidth(startWidth + startX - moveEvent.clientX, splitContainerWidth);
    };

    const onUp = () => {
      draggingRef.current = false;
      setResizing(false);
      if (splitContainerWidth && splitContainerWidth > 0) {
        updateLayoutPreferences({
          sidePanelRatio: useSidePanelStore.getState().panelWidth / splitContainerWidth,
        });
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth, setPanelWidth, setResizing]);

  return (
    <aside
      ref={panelRef}
      className={cn(
        `relative h-full overflow-hidden border-l ${LAYOUT_DIVIDER_CLASS} bg-background`,
        isExpanded ? 'absolute inset-y-0 right-0 z-30 w-full shadow-[-18px_0_40px_-28px_hsl(var(--surface-shadow-strong)/0.5)]' : 'shrink-0',
        !isVisible && 'pointer-events-none invisible',
        isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
      )}
      aria-hidden={!isVisible}
      style={{ width: isVisible && isExpanded ? '100%' : isVisible && isOpen ? panelWidth : 0 }}
    >
      <div
        className="group absolute inset-y-0 -left-1 z-40 w-2 cursor-col-resize"
        onMouseDown={handleMouseDown}
        aria-hidden="true"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-200 group-hover:bg-primary/22" />
      </div>

      <div className="flex h-full w-full min-w-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/25 px-1">
          <TooltipHint content="收起面板">
            <button
              aria-label="收起面板"
              className="rounded-lg p-1.5 text-muted-foreground/64 transition-colors hover:bg-muted/55 hover:text-foreground"
              onClick={closePanel}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </TooltipHint>

          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
                onClose={() => closeTab(tab.id)}
                onCloseOther={() => closeOtherTabs(tab.id)}
                onCloseAll={closeAllTabs}
              />
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {projectPath ? (
              <DropdownMenu>
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label="打开标签"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>打开标签</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="end" className="z-190 min-w-32">
                  <DropdownMenuItem onClick={openReview} icon={<FileSearch className="h-3.5 w-3.5" />}>
                    审查
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openTerminal} icon={<Terminal className="h-3.5 w-3.5" />}>
                    终端
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <TooltipHint content="请先选择项目">
                <span aria-label="请先选择项目">
                  <button
                    type="button"
                    className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-lg text-muted-foreground opacity-45"
                    disabled
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </span>
              </TooltipHint>
            )}
            <TooltipHint content={isExpanded ? '恢复面宽' : '展开预览'}>
              <button
                type="button"
                data-testid="side-panel-expand-toggle"
                aria-label={isExpanded ? '恢复面宽' : '展开预览'}
                onClick={toggleExpanded}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
              >
                {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </TooltipHint>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {terminalTabs.map((tab) => {
            const isActive = isVisible && isOpen && activeTab?.id === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  'absolute inset-0',
                  isActive ? 'pointer-events-auto visible z-10' : 'pointer-events-none invisible z-0',
                )}
                aria-hidden={!isActive}
              >
                <TerminalPanel
                  tabId={tab.id}
                  terminalId={tab.terminalId}
                  projectPath={tab.projectPath ?? projectPath ?? ''}
                  isActive={isActive}
                />
              </div>
            );
          })}
          {activeTab ? (
            activeTab.kind === 'review' ? (
              <ReviewPanel key={activeTab.id} projectPath={activeTab.projectPath ?? projectPath ?? ''} />
            ) : activeTab.kind === 'diff' ? (
              <div key={activeTab.id} className="h-full overflow-auto">
                <DiffView oldContent={activeTab.diffOldContent ?? ''} newContent={activeTab.diffNewContent ?? ''} />
              </div>
            ) : activeTab.kind === 'plan' ? (
              <PlanPreviewPanel
                key={activeTab.id}
                planFilePath={activeTab.planFilePath}
                planContent={activeTab.planContent}
              />
            ) : activeTab.kind === 'file' ? (
              <FileEditorPanel key={activeTab.id} tab={activeTab} />
            ) : activeTab.kind === 'subagent' ? (
              <SubagentPreviewPanel
                key={activeTab.id}
                sessionId={activeTab.subagentSessionId ?? activeTab.subagentId ?? ''}
                subagentId={activeTab.subagentId ?? ''}
              />
            ) : null
          ) : (
            <SidePanelEmpty projectPath={projectPath} onOpenReview={openReview} onOpenTerminal={openTerminal} />
          )}
        </div>
      </div>
    </aside>
  );
}

function TabButton({
  tab,
  active,
  onClick,
  onClose,
  onCloseOther,
  onCloseAll,
}: {
  tab: SidePanelTab;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onCloseOther: () => void;
  onCloseAll: () => void;
}) {
  const Icon = tab.kind === 'review'
    ? FileSearch
    : tab.kind === 'terminal'
      ? Terminal
      : tab.kind === 'diff'
        ? FileCode
        : tab.kind === 'subagent'
          ? Bot
          : FileText;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'group flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors',
            active
              ? 'border-border/55 bg-muted/45 text-foreground'
              : 'border-transparent text-muted-foreground/70 hover:bg-muted/35 hover:text-foreground/86',
          )}
          onClick={onClick}
        >
          {tab.kind === 'plan' || tab.kind === 'file' ? (
            <FileTypeIcon filePath={tab.kind === 'plan' ? tab.planFilePath ?? tab.title : tab.filePath ?? tab.title} />
          ) : (
            <Icon className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{tab.title}</span>
          {tab.kind === 'subagent' && tab.subagentStatus && (
            <SubagentStatusDot status={tab.subagentStatus} />
          )}
          <span
            role="button"
            tabIndex={-1}
            className="ml-1 rounded p-0.5 text-muted-foreground/45 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-36">
        <ContextMenuItem onClick={onClose}>关闭标签</ContextMenuItem>
        <ContextMenuItem onClick={onCloseOther}>关闭其他标签</ContextMenuItem>
        <ContextMenuItem onClick={onCloseAll}>关闭所有标签</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SubagentStatusDot({ status }: { status: NonNullable<SidePanelTab['subagentStatus']> }) {
  return (
    <span
      aria-label={`子智能体状态: ${status}`}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse bg-success',
        status === 'completed' && 'bg-primary',
        status === 'failed' && 'bg-destructive',
        status === 'canceled' && 'bg-muted-foreground/55',
      )}
    />
  );
}

function SidePanelEmpty({
  projectPath,
  onOpenReview,
  onOpenTerminal,
}: {
  projectPath?: string | null;
  onOpenReview: () => void;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-2xl font-semibold tracking-normal text-foreground/88">打开标签页</h2>
      <p className="mt-3 text-sm text-muted-foreground">
        {projectPath ? '选择要在侧边面板中打开的标签。' : '请先选择一个项目。'}
      </p>
      <div className="mt-7 grid w-full max-w-105 grid-cols-2 gap-3">
        <button
          className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg bg-muted/45 text-foreground/82 transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!projectPath}
          onClick={onOpenReview}
        >
          <FileSearch className="h-5 w-5" />
          <span className="text-sm">审查</span>
        </button>
        <button
          className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg bg-muted/45 text-foreground/82 transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!projectPath}
          onClick={onOpenTerminal}
        >
          <Terminal className="h-5 w-5" />
          <span className="text-sm">终端</span>
        </button>
      </div>
    </div>
  );
}
