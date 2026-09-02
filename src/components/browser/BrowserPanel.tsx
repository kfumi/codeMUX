import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Globe,
  MoreVertical,
  Plus,
  RotateCw,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  ELEMENT_SELECTOR_POLL_SCRIPT,
  ELEMENT_SELECTOR_START_SCRIPT,
  ELEMENT_SELECTOR_STOP_SCRIPT,
} from '../../lib/elementSelector';
import { browserPageTitle } from '../../lib/browserPage';
import { browserApi } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { useBrowserElementStore } from '../../stores/browserElementStore';
import { useBrowserStore, type BrowserPage } from '../../stores/browserStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { TooltipHint } from '../ui/tooltip';

const EMPTY_PAGE_IDS: string[] = [];

interface BrowserPanelProps {
  tabId: string;
  sessionId: string;
  isActive: boolean;
}

export function BrowserPanel({ tabId, sessionId, isActive }: BrowserPanelProps) {
  const pageIds = useBrowserStore((state) => state.pageIdsByPanel[tabId] ?? EMPTY_PAGE_IDS);
  const activePageId = useBrowserStore((state) => state.activePageIdByPanel[tabId] ?? null);
  const pages = useBrowserStore((state) => state.pages);
  const inspectingPageId = useBrowserStore((state) => state.inspectingPageId);
  const ensureBlankPage = useBrowserStore((state) => state.ensureBlankPage);
  const addPage = useBrowserStore((state) => state.addPage);
  const closePage = useBrowserStore((state) => state.closePage);
  const setActivePage = useBrowserStore((state) => state.setActivePage);
  const setAddressDraft = useBrowserStore((state) => state.setAddressDraft);
  const navigate = useBrowserStore((state) => state.navigate);
  const back = useBrowserStore((state) => state.back);
  const forward = useBrowserStore((state) => state.forward);
  const reload = useBrowserStore((state) => state.reload);
  const setPanelBounds = useBrowserStore((state) => state.setPanelBounds);
  const syncVisibility = useBrowserStore((state) => state.syncVisibility);
  const startInspect = useBrowserStore((state) => state.startInspect);
  const stopInspect = useBrowserStore((state) => state.stopInspect);
  const destroyPanel = useBrowserStore((state) => state.destroyPanel);
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ensureBlankPage(tabId);
  }, [ensureBlankPage, tabId]);

  useEffect(() => {
    return () => {
      const state = useSidePanelStore.getState();
      const stillOpen =
        state.tabs.some((tab) => tab.id === tabId)
        || Object.values(state.scopes).some((snapshot) => snapshot.tabs.some((tab) => tab.id === tabId));
      if (!stillOpen) {
        void destroyPanel(tabId);
      }
    };
  }, [destroyPanel, tabId]);

  useEffect(() => {
    const visiblePageId = isActive ? activePageId : null;
    void syncVisibility(tabId, visiblePageId);
  }, [activePageId, isActive, syncVisibility, tabId]);

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node || !isActive) return;

    const updateBounds = () => {
      const rect = node.getBoundingClientRect();
      void setPanelBounds(tabId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(node);
    window.addEventListener('resize', updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [isActive, setPanelBounds, tabId]);

  const activePage = activePageId ? pages[activePageId] : undefined;
  const inspecting = inspectingPageId === activePageId;

  useEffect(() => {
    if (!isActive && inspecting) {
      stopInspect();
    }
  }, [inspecting, isActive, stopInspect]);

  useEffect(() => {
    if (!isActive || !inspecting || !activePageId || !activePage?.hostAttached || activePage.isLoading) return;

    let cancelled = false;
    const run = async () => {
      try {
        await browserApi.evaluate(activePageId, ELEMENT_SELECTOR_START_SCRIPT);
      } catch (error) {
        if (!cancelled) {
          stopInspect();
          toast.error(error instanceof Error ? error.message : '无法开始元素检查');
        }
      }
    };
    void run();

    const timer = window.setInterval(async () => {
      try {
        const raw = await browserApi.evaluate(activePageId, ELEMENT_SELECTOR_POLL_SCRIPT);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const result = parsed as {
          captured?: {
            tag?: string;
            text?: string;
            selector?: string;
            url?: string;
            width?: number;
            height?: number;
            color?: string;
            font?: string;
          } | null;
          cancelled?: boolean;
        };
        if (result.cancelled) {
          stopInspect();
          return;
        }
        if (result.captured) {
          useBrowserElementStore.getState().add(sessionId, {
            url: result.captured.url || activePage.url,
            tag: result.captured.tag || 'unknown',
            text: result.captured.text || '',
            selector: result.captured.selector,
            width: result.captured.width,
            height: result.captured.height,
            color: result.captured.color,
            font: result.captured.font,
          });
        }
      } catch (error) {
        stopInspect();
        toast.error(error instanceof Error ? error.message : '元素检查失败');
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void browserApi.evaluate(activePageId, ELEMENT_SELECTOR_STOP_SCRIPT).catch(() => {});
    };
  }, [activePage?.hostAttached, activePage?.isLoading, activePage?.url, activePageId, inspecting, isActive, sessionId, stopInspect]);

  const handleClosePage = useCallback(async (pageId: string) => {
    const result = await closePage(pageId);
    if (result.panelEmpty) {
      closeTab(tabId);
    }
  }, [closePage, closeTab, tabId]);

  const handleInspectToggle = useCallback(async () => {
    if (!activePage?.hostAttached || activePage.isLoading) return;
    if (inspecting) {
      stopInspect();
      return;
    }
    startInspect(activePage.id);
  }, [activePage, inspecting, startInspect, stopInspect]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', !isActive && 'hidden')}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/25 px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {pageIds.map((pageId) => {
            const page = pages[pageId];
            if (!page) return null;
            return (
              <BrowserPageTab
                key={pageId}
                page={page}
                active={pageId === activePageId}
                onClick={() => void setActivePage(tabId, pageId)}
                onClose={() => void handleClosePage(pageId)}
              />
            );
          })}
        </div>
        <TooltipHint content="新标签页">
          <button
            type="button"
            aria-label="新标签页"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
            onClick={() => addPage(tabId)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </TooltipHint>
      </div>

      <BrowserToolbar
        page={activePage}
        inspecting={inspecting}
        onAddressChange={(value) => activePage && setAddressDraft(activePage.id, value)}
        onSubmit={() => activePage && void navigate(activePage.id)}
        onBack={() => activePage && void back(activePage.id)}
        onForward={() => activePage && void forward(activePage.id)}
        onReload={() => activePage && void reload(activePage.id)}
        onInspect={() => void handleInspectToggle()}
      />

      {activePage?.lastError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/8 px-3 py-1.5 text-ui-caption text-destructive">
          {activePage.lastError}
        </div>
      ) : null}

      <div ref={hostRef} className="relative min-h-0 flex-1 bg-background">
        {!activePage?.hostAttached && (
          <div className="flex h-full items-center justify-center text-ui-body text-muted-foreground">
            在地址栏输入网址并回车
          </div>
        )}
      </div>
    </div>
  );
}

function BrowserPageTab({
  page,
  active,
  onClick,
  onClose,
}: {
  page: BrowserPage;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const title = browserPageTitle(page.title, page.url);
  return (
    <button
      type="button"
      className={cn(
        'group flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-ui-caption transition-colors',
        active
          ? 'border-border/55 bg-muted/45 text-foreground'
          : 'border-transparent text-muted-foreground/70 hover:bg-muted/35 hover:text-foreground/86',
      )}
      onClick={onClick}
    >
      {page.faviconUrl ? (
        <img src={page.faviconUrl} alt="" className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Globe className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">{title}</span>
      {page.isLoading ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      ) : null}
      <span
        role="button"
        tabIndex={-1}
        className="rounded p-0.5 text-muted-foreground/45 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
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

function BrowserToolbar({
  page,
  inspecting,
  onAddressChange,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onInspect,
}: {
  page?: BrowserPage;
  inspecting: boolean;
  onAddressChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onInspect: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const canInspect = Boolean(page?.hostAttached) && !page?.isLoading;

  const copyUrl = async () => {
    if (!page?.url) return;
    try {
      await navigator.clipboard.writeText(page.url);
      setCopying(true);
      window.setTimeout(() => setCopying(false), 1200);
    } catch {
      toast.error('复制链接失败');
    }
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/25 px-1.5">
      <TooltipHint content="后退">
        <button
          type="button"
          aria-label="后退"
          disabled={!page?.canGoBack}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          onClick={onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <TooltipHint content="前进">
        <button
          type="button"
          aria-label="前进"
          disabled={!page?.canGoForward}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          onClick={onForward}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <TooltipHint content="刷新">
        <button
          type="button"
          aria-label="刷新"
          disabled={!page?.hostAttached}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          onClick={onReload}
        >
          <RotateCw className={cn('h-3.5 w-3.5', page?.isLoading && 'animate-spin')} />
        </button>
      </TooltipHint>
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          aria-label="网址"
          value={page?.addressDraft ?? ''}
          placeholder="输入网址"
          className="h-7 w-full rounded-md border border-border/55 bg-muted/35 px-2.5 font-mono text-code text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-primary/45"
          onChange={(event) => onAddressChange(event.target.value)}
        />
      </form>
      <TooltipHint content={copying ? '已复制' : '复制链接'}>
        <button
          type="button"
          aria-label="复制链接"
          disabled={!page?.url}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void copyUrl()}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <TooltipHint content={inspecting ? '退出元素检查' : '元素检查'}>
        <button
          type="button"
          aria-label="元素检查"
          aria-pressed={inspecting}
          disabled={!canInspect}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-35',
            inspecting
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-muted/55 hover:text-foreground',
          )}
          onClick={onInspect}
        >
          <WandSparkles className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="浏览器菜单"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-190 min-w-36">
          <DropdownMenuItem disabled={!page?.hostAttached} onClick={() => page && void browserApi.openDevtools(page.id)}>
            开发者工具
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
