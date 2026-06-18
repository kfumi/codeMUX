import { Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export function StatusBar() {
  const needsProxy = useSettingsStore((s) => s.getNeedsProxy());
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  const proxyToggling = useSettingsStore((s) => s.proxyToggling);
  const startProxy = useSettingsStore((s) => s.startProxy);
  const stopProxy = useSettingsStore((s) => s.stopProxy);

  const port = proxyUrl?.match(/:(\d+)$/)?.[1];

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-border/40 bg-muted/30 px-3 text-[11px] text-muted-foreground select-none">
      {/* 左侧 */}
      <div className="flex items-center gap-3">
        {needsProxy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void (proxyRunning ? stopProxy() : startProxy())}
                disabled={proxyToggling}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 transition-colors hover:bg-muted/60',
                  proxyToggling && 'opacity-60',
                )}
              >
                {proxyToggling ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span
                    className={cn(
                      'inline-block h-2 w-2 rounded-full',
                      proxyRunning ? 'bg-green-500' : 'bg-muted-foreground/50',
                    )}
                  />
                )}
                <span>
                  {proxyRunning ? `Proxy :${port ?? '...'}` : 'Proxy 未运行'}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{proxyRunning ? `点击停止代理 (${proxyUrl})` : '点击启动代理'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* 右侧预留 */}
      <div data-slot="status-bar-right" className="flex items-center gap-3" />
    </div>
  );
}
