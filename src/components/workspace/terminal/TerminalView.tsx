import '@xterm/xterm/css/xterm.css';

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { getIsDark } from '../../../lib/appearance';
import { terminalRegistry } from '../../../lib/terminal/sessionRegistry';
import { terminalTheme } from '../../../lib/terminal/terminalTheme';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../ui/context-menu';
import { TerminalScrollbar } from './TerminalScrollbar';

/**
 * 一个终端标签的视图壳。
 *
 * 它**不拥有** xterm 或 PTY：只把 registry 里的 DOM 宿主挂进自己的容器，卸载时摘回。
 * 因此切标签、切会话、收起面板都不会重建终端；只有显式关闭标签才走 `release`。
 * 决策见 `docs/adr/0022-terminal-session-registry-ownership.md`。
 */
export function TerminalView({
  sessionKey,
  projectPath,
  isActive = true,
}: {
  /** 稳定的会话 key（侧面板用 tab id，底部 dock 用 `dock:<project>:<n>`）。 */
  sessionKey: string;
  projectPath: string;
  isActive?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [canCopy, setCanCopy] = useState(false);

  const subscribe = useCallback(
    (listener: () => void) => terminalRegistry.subscribe(sessionKey, listener),
    [sessionKey],
  );
  const getSnapshot = useCallback(
    () => terminalRegistry.getSnapshot(sessionKey),
    [sessionKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // 挂载/摘除宿主。`isActive` 故意不在依赖里：它只影响可见性与输出解析，
  // 不应该让组件重新挂载（那正是要避免的「重建终端」）。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !projectPath) return;

    terminalRegistry.acquire(sessionKey, { projectPath, container, active: isActive });
    setViewport(container.querySelector<HTMLElement>('.xterm-viewport'));

    return () => {
      terminalRegistry.unmount(sessionKey);
      setViewport(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, projectPath]);

  useLayoutEffect(() => {
    terminalRegistry.setActive(sessionKey, isActive);
  }, [sessionKey, isActive]);

  const background = terminalTheme(getIsDark()).background;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setCanCopy(terminalRegistry.hasSelection(sessionKey));
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className="terminal-panel relative h-full min-h-0 min-w-0"
          style={{ backgroundColor: background }}
        >
          <div
            ref={containerRef}
            data-terminal-host=""
            className="terminal-panel-container h-full min-h-0 min-w-0 w-full overflow-hidden p-3"
          />
          <TerminalScrollbar viewport={viewport} isActive={isActive} />
          {snapshot.error && (
            <div className="absolute inset-x-4 top-4 rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-sm text-destructive shadow-sm">
              {snapshot.error}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-180 min-w-32">
        <ContextMenuItem
          disabled={!canCopy}
          onClick={() => {
            void terminalRegistry.copySelection(sessionKey);
          }}
        >
          复制
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            void terminalRegistry.paste(sessionKey);
          }}
        >
          粘贴
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
