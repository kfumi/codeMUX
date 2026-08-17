import { AlertCircle, Loader2 } from 'lucide-react';

import { cn } from '../lib/utils';

interface DesktopOfflineOverlayProps {
  detail?: string | null;
  reconnecting?: boolean;
  onReconnect: () => void;
}

export function DesktopOfflineOverlay({
  detail,
  reconnecting = false,
  onReconnect,
}: DesktopOfflineOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 backdrop-blur-sm sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-offline-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border/60 bg-[hsl(var(--surface-2))] shadow-2xl"
      >
        <div className="border-b border-border/50 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-2 inline-flex rounded-full bg-destructive/15 px-2.5 py-0.5 text-[11px] font-medium text-destructive">
                电脑端离线
              </div>
              <h2 id="desktop-offline-title" className="text-lg font-semibold text-foreground">
                桌面端已离线
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                电脑端已经断开连接，当前手机页面不能继续控制桌面工作区。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="text-sm font-medium text-foreground">下一步</div>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>确认电脑端 CodeMUX 仍在运行，且移动伴侣已开启。</li>
              <li>确认手机与电脑在同一局域网内。</li>
              <li>桌面恢复后点击下方「重新连接」。</li>
            </ol>
          </div>

          {detail ? (
            <div className="rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5">
              <div className="text-[11px] font-medium text-muted-foreground">连接详情</div>
              <div className="mt-1 whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-muted-foreground">
                {detail}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-opacity',
              reconnecting && 'opacity-70',
            )}
            disabled={reconnecting}
            onClick={() => void onReconnect()}
          >
            {reconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            重新连接
          </button>
        </div>
      </div>
    </div>
  );
}
