import { ChevronRight, FileSearch, Plus, Terminal, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { cn } from '../../lib/utils';
import { useSidePanelStore, type SidePanelTab } from '../../stores/sidePanelStore';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { ReviewPanel } from './review/ReviewPanel';
import { TerminalPanel } from './terminal/TerminalPanel';

interface SidePanelProps {
  projectPath?: string | null;
  scopeId: string;
}

export function SidePanel({ projectPath, scopeId }: SidePanelProps) {
  const isOpen = useSidePanelStore((state) => state.isOpen);
  const panelWidth = useSidePanelStore((state) => state.panelWidth);
  const isResizing = useSidePanelStore((state) => state.isResizing);
  const tabs = useSidePanelStore((state) => state.tabs);
  const activeTabId = useSidePanelStore((state) => state.activeTabId);
  const setPanelWidth = useSidePanelStore((state) => state.setPanelWidth);
  const setResizing = useSidePanelStore((state) => state.setResizing);
  const setActiveTab = useSidePanelStore((state) => state.setActiveTab);
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const closePanel = useSidePanelStore((state) => state.closePanel);
  const openReviewTab = useSidePanelStore((state) => state.openReviewTab);
  const openTerminalTab = useSidePanelStore((state) => state.openTerminalTab);
  const setScope = useSidePanelStore((state) => state.setScope);
  const draggingRef = useRef(false);

  useLayoutEffect(() => {
    setScope(scopeId);
  }, [scopeId, setScope]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, tabs]);

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

    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      setPanelWidth(startWidth + startX - moveEvent.clientX);
    };

    const onUp = () => {
      draggingRef.current = false;
      setResizing(false);
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
      className={cn(
        'relative h-full shrink-0 overflow-hidden border-l border-border/35 bg-background',
        isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
      )}
      style={{ width: isOpen ? panelWidth : 0 }}
    >
      <div className="group absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize" onMouseDown={handleMouseDown}>
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/22" />
      </div>

      <div className="flex h-full w-full min-w-0 flex-col pl-2">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/25 px-3">
          <button
            className="rounded-lg p-1.5 text-muted-foreground/64 transition-colors hover:bg-muted/55 hover:text-foreground"
            title="收起面板"
            onClick={closePanel}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>

          {projectPath ? (
            <DropdownMenu
              align="right"
              panelClassName="z-[190] min-w-32"
              trigger={(
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
                  title="打开标签"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            >
              <DropdownMenuItem onClick={openReview} icon={<FileSearch className="h-3.5 w-3.5" />}>
                审核
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openTerminal} icon={<Terminal className="h-3.5 w-3.5" />}>
                终端
              </DropdownMenuItem>
            </DropdownMenu>
          ) : (
            <span title="请先选择项目">
              <button
                type="button"
                className="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-lg text-muted-foreground opacity-45"
                disabled
              >
                <Plus className="h-4 w-4" />
              </button>
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {activeTab ? (
            activeTab.kind === 'review' ? (
              <ReviewPanel key={activeTab.id} projectPath={activeTab.projectPath ?? projectPath ?? ''} />
            ) : (
              <TerminalPanel key={activeTab.id} tabId={activeTab.id} projectPath={activeTab.projectPath ?? projectPath ?? ''} />
            )
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
}: {
  tab: SidePanelTab;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const Icon = tab.kind === 'review' ? FileSearch : Terminal;

  return (
    <button
      className={cn(
        'group flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors',
        active
          ? 'border-border/55 bg-muted/45 text-foreground'
          : 'border-transparent text-muted-foreground/70 hover:bg-muted/35 hover:text-foreground/86',
      )}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{tab.title}</span>
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
          <span className="text-sm">审核</span>
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
