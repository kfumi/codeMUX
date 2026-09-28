import { AlertCircle, Download, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHostCapabilities } from '@/hooks/useHostCapabilities';
import { cn } from '@/lib/utils';

import { useUpdaterContext } from '../UpdaterProvider';
import { getUpdateEntryView } from '../updateDisplay';

const TONE_ICON = {
  available: Download,
  busy: Loader2,
  error: AlertCircle,
} as const;

export function UpdateEntry() {
  const updater = useUpdaterContext();
  // 工单 02:自动更新是壳独占能力,浏览器/移动形态隐藏入口而非留一个死按钮。
  const capabilities = useHostCapabilities();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const view = getUpdateEntryView(updater.stage, updater.progress, updater.error);

  if (!view || !capabilities.has('updater')) {
    return null;
  }

  const Icon = TONE_ICON[view.tone];

  // available → 确认后开装;error → 先重新检查(拿到的 update handle 才能下载;
  // 失败后壳侧缓存的 handle 可能已失效),成功则回到确认框。
  const handleClick = () => {
    if (updater.stage === 'available') {
      setConfirmOpen(true);
      return;
    }
    if (updater.stage === 'error') {
      void updater
        .checkForUpdates({ interactive: true, announceNoUpdate: false, throwOnError: true })
        .then((update) => {
          if (update) {
            setConfirmOpen(true);
          }
        })
        .catch(() => {
          // checkForUpdates 自身已把 stage 置为 error 并带上原因。
        });
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={view.disabled}
            onClick={handleClick}
            className={cn(
              'h-7 gap-1.5 rounded-md px-2.5 text-ui-meta shadow-none',
              'border border-transparent',
              view.tone === 'available' && 'bg-[hsl(var(--sidebar-accent)/0.16)] text-[hsl(var(--sidebar-accent))] hover:bg-[hsl(var(--sidebar-accent)/0.24)] hover:text-[hsl(var(--sidebar-accent))]',
              view.tone === 'busy' && 'text-foreground/58',
              // 语义色直用,不叠透明度(见 AGENTS.md 文字对比两档规范)。
              view.tone === 'error' && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', view.tone === 'busy' && 'animate-spin')} />
            <span>{view.label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{view.hint}</p>
        </TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`安装更新 ${updater.version ?? ''}？`}
        description="应用将下载新版本并在安装完成后重启。请先保存正在编辑的重要内容。"
        confirmLabel="下载并安装"
        cancelLabel="稍后"
        onConfirm={() => {
          void updater.startUpdate();
        }}
      />
    </>
  );
}
