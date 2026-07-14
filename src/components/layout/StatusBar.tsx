import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export function StatusBar() {
  const proxyRunning = useSettingsStore((s) => s.proxyRunning);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);

  const port = proxyUrl?.match(/:(\d+)$/)?.[1];

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-border/62 bg-[hsl(var(--surface-1))]/92 px-3 text-[11px] text-muted-foreground/74 select-none">
      {/* 左侧 */}
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 rounded-sm px-1.5 py-0.5">
              <span className={proxyRunning ? 'inline-block h-2 w-2 rounded-full bg-[hsl(var(--success))]' : 'inline-block h-2 w-2 rounded-full bg-muted-foreground/50'} />
              <span>
                {proxyRunning ? `Proxy :${port ?? '...'}` : 'Proxy 未运行'}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {proxyRunning ? `由当前 Codex 会话自动运行 (${proxyUrl})` : '由 Codex 档案在会话启动时按需运行'}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* 右侧预留 */}
      <div data-slot="status-bar-right" className="flex items-center gap-3" />
    </div>
  );
}
