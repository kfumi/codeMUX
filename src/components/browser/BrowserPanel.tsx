import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  MonitorSmartphone,
  MoreHorizontal,
  MousePointer2,
  RotateCw,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  ELEMENT_SELECTOR_POLL_SCRIPT,
  ELEMENT_SELECTOR_START_SCRIPT,
  ELEMENT_SELECTOR_STOP_SCRIPT,
} from '../../lib/elementSelector';
import { bindElectronBrowserContainer } from '../../lib/browser/electronBrowserHost';
import { isElectronDesktop } from '../../lib/desktop-bridge';
import { shellFacade } from '../../lib/facades/shell-facade';
import { electronBrowserHost as browserApi } from '../../lib/browser/electronBrowserHost';
import { cn } from '../../lib/utils';
import { useBrowserElementStore } from '../../stores/browserElementStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import {
  BROWSER_REFERENCE_VIEWPORT,
  BROWSER_VIEWPORT_CHROME_HEIGHT,
  BROWSER_VIEWPORT_OPTIONS,
  browserViewportScaleLabel,
  formatViewportSize,
  type BrowserViewportMode,
} from '../../lib/browserViewport';
import { useBrowserDropdownHostGuard, useBrowserOverlayOpenChange } from '../../lib/useNativeViewOccluder';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { TooltipHint } from '../ui/tooltip';
import type { BrowserPage } from '../../stores/browserStore';

interface BrowserPanelProps {
  tabId: string;
  sessionId: string;
  isActive: boolean;
}

export function BrowserPanel({ tabId, sessionId, isActive }: BrowserPanelProps) {
  const activePageId = useBrowserStore((state) => state.activePageIdByPanel[tabId] ?? null);
  const pages = useBrowserStore((state) => state.pages);
  const inspectingPageId = useBrowserStore((state) => state.inspectingPageId);
  const browserInitialUrl = useSidePanelStore(
    (state) => state.tabs.find((tab) => tab.id === tabId)?.browserInitialUrl,
  );
  const ensureBlankPage = useBrowserStore((state) => state.ensureBlankPage);
  const setAddressDraft = useBrowserStore((state) => state.setAddressDraft);
  const navigate = useBrowserStore((state) => state.navigate);
  const back = useBrowserStore((state) => state.back);
  const forward = useBrowserStore((state) => state.forward);
  const reload = useBrowserStore((state) => state.reload);
  const setPanelBounds = useBrowserStore((state) => state.setPanelBounds);
  const setViewportMode = useBrowserStore((state) => state.setViewportMode);
  const setViewportPreview = useBrowserStore((state) => state.setViewportPreview);
  const viewportMode = useBrowserStore((state) => state.viewportModeByPanel[tabId] ?? 'fit');
  const previewActive = useBrowserStore((state) => state.previewByPanel[tabId] ?? false);
  const startInspect = useBrowserStore((state) => state.startInspect);
  const stopInspect = useBrowserStore((state) => state.stopInspect);
  const destroyPanel = useBrowserStore((state) => state.destroyPanel);
  const clearBrowserInitialUrl = useSidePanelStore((state) => state.clearBrowserInitialUrl);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ensureBlankPage(tabId);
  }, [ensureBlankPage, tabId]);

  // Electron(工单 07):把 `<webview>` 挂进面板容器(页面属 DOM 布局);
  // Tauri 用原生子 webview,不挂载,此 effect 在 Tauri/Web 下为 no-op。
  useEffect(() => {
    if (!isElectronDesktop() || !activePageId) return;
    const host = hostRef.current;
    if (!host) return;
    return bindElectronBrowserContainer(activePageId, host);
  }, [activePageId, tabId]);

  useEffect(() => {
    if (!isActive || !browserInitialUrl) return;
    const pageId = useBrowserStore.getState().activePageIdByPanel[tabId];
    if (!pageId) return;
    let cancelled = false;
    void (async () => {
      await navigate(pageId, browserInitialUrl);
      if (!cancelled) {
        clearBrowserInitialUrl(tabId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [browserInitialUrl, clearBrowserInitialUrl, isActive, navigate, tabId]);

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

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node || !isActive) return;

    const updateBounds = () => {
      const rect = node.getBoundingClientRect();
      void setPanelBounds(tabId, {
        x: Math.ceil(rect.left),
        y: Math.ceil(rect.top),
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
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
  }, [isActive, setPanelBounds, tabId, viewportMode, previewActive]);

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
          stopInspect();
          return;
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
      <BrowserToolbar
        page={activePage}
        inspecting={inspecting}
        previewActive={previewActive}
        onAddressChange={(value) => activePage && setAddressDraft(activePage.id, value)}
        onSubmit={() => activePage && void navigate(activePage.id)}
        onBack={() => activePage && void back(activePage.id)}
        onForward={() => activePage && void forward(activePage.id)}
        onReload={() => activePage && void reload(activePage.id)}
        onInspect={() => void handleInspectToggle()}
        onTogglePreview={() => void setViewportPreview(tabId, !previewActive)}
      />

      {activePage?.lastError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/8 px-3 py-1.5 text-ui-caption text-destructive">
          {activePage.lastError}
        </div>
      ) : null}

      <div
        className={cn(
          'relative flex min-h-0 flex-1 flex-col',
          previewActive ? 'bg-muted/45' : 'bg-background',
        )}
      >
        {previewActive ? (
          <BrowserViewportChrome
            viewportMode={viewportMode}
            onSelectMode={(mode) => void setViewportMode(tabId, mode)}
          />
        ) : null}

        <div ref={hostRef} className="relative min-h-0 flex-1">
          {!activePage?.hostAttached && (
            <div className="flex h-full items-center justify-center text-ui-body text-muted-foreground">
              在地址栏输入网址并回车
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BrowserViewportChrome({
  viewportMode,
  onSelectMode,
}: {
  viewportMode: BrowserViewportMode;
  onSelectMode: (mode: BrowserViewportMode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuContentRef = useRef<HTMLDivElement | null>(null);
  const handleMenuOpenChange = useBrowserOverlayOpenChange(setMenuOpen);

  useBrowserDropdownHostGuard('browser:viewport-menu', menuOpen, menuContentRef);

  return (
    <div
      className="relative z-10 flex shrink-0 items-center justify-center gap-2 px-10"
      style={{ height: BROWSER_VIEWPORT_CHROME_HEIGHT }}
    >
      <span className="text-ui-meta text-muted-foreground">
        {formatViewportSize(BROWSER_REFERENCE_VIEWPORT.width, BROWSER_REFERENCE_VIEWPORT.height)}
      </span>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="调整预览尺寸"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent py-0.5 text-ui-meta text-muted-foreground outline-none hover:text-foreground"
          >
            {browserViewportScaleLabel(viewportMode)}
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent ref={menuContentRef} side="bottom" align="center" avoidCollisions={false} className="z-180 min-w-36">
          {BROWSER_VIEWPORT_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={String(option.value)}
              className={cn(option.value === viewportMode && 'bg-muted/70 text-foreground')}
              onClick={() => onSelectMode(option.value)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function BrowserToolbar({
  page,
  inspecting,
  previewActive,
  onAddressChange,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onInspect,
  onTogglePreview,
}: {
  page?: BrowserPage;
  inspecting: boolean;
  previewActive: boolean;
  onAddressChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onInspect: () => void;
  onTogglePreview: () => void;
}) {
  const canInspect = Boolean(page?.hostAttached) && !page?.isLoading;
  const pageUrl = page?.url || page?.addressDraft || '';
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuContentRef = useRef<HTMLDivElement | null>(null);
  const handleMoreMenuOpenChange = useBrowserOverlayOpenChange(setMoreMenuOpen);

  useBrowserDropdownHostGuard('browser:more-menu', moreMenuOpen, moreMenuContentRef);

  const openInDefaultBrowser = async () => {
    if (!pageUrl) return;
    try {
      await shellFacade.openExternal(pageUrl);
    } catch {
      toast.error('无法在默认浏览器中打开');
    }
  };

  const openDevtools = async () => {
    if (!page?.hostAttached) return;
    try {
      await browserApi.openDevtools(page.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开调试工具');
    }
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
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
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-liga-none h-7 w-full rounded-md border border-border bg-muted/35 px-2.5 text-ui-compact text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/45"
          onChange={(event) => onAddressChange(event.target.value)}
        />
      </form>
      <TooltipHint content="自由尺寸">
        <button
          type="button"
          aria-label="自由尺寸"
          aria-pressed={previewActive}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
            previewActive
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-muted/55 hover:text-foreground',
          )}
          onClick={onTogglePreview}
        >
          <MonitorSmartphone className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <TooltipHint content={inspecting ? '退出元素检查' : '选择网页元素加入聊天'}>
        <button
          type="button"
          aria-label="选择网页元素加入聊天"
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
          <MousePointer2 className="h-3.5 w-3.5" />
        </button>
      </TooltipHint>
      <DropdownMenu open={moreMenuOpen} onOpenChange={handleMoreMenuOpenChange}>
        <TooltipHint content="更多浏览器操作">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="更多浏览器操作"
              title="更多浏览器操作"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipHint>
        <DropdownMenuContent ref={moreMenuContentRef} side="bottom" align="end" avoidCollisions={false} className="z-180 min-w-44">
          <DropdownMenuItem disabled={!pageUrl} onClick={() => void openInDefaultBrowser()}>
            在默认浏览器中打开
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!page?.hostAttached} onClick={() => void openDevtools()}>
            打开调试工具
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
