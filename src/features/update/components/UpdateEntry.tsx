import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { UpdateProgress, UpdateStage } from '../hooks/useUpdater';
import { useUpdaterContext } from '../UpdaterProvider';

const getProgressPercent = (progress?: UpdateProgress) => {
  const totalBytes = progress?.totalBytes;
  const downloadedBytes = progress?.downloadedBytes ?? 0;

  if (!totalBytes || totalBytes <= 0) {
    return null;
  }

  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
};

const getEntryState = (stage: UpdateStage, progress?: UpdateProgress) => {
  if (stage === 'available') {
    return {
      label: '更新',
      tooltip: '发现新版本，点击安装',
      disabled: false,
      tone: 'available' as const,
      Icon: Download,
    };
  }

  if (stage === 'downloading') {
    const percent = getProgressPercent(progress);
    return {
      label: percent === null ? '下载中' : `下载中 ${percent}%`,
      tooltip: '正在下载更新',
      disabled: true,
      tone: 'busy' as const,
      Icon: Loader2,
    };
  }

  if (stage === 'installing') {
    return {
      label: '安装中',
      tooltip: '正在安装更新',
      disabled: true,
      tone: 'busy' as const,
      Icon: Loader2,
    };
  }

  if (stage === 'restarting') {
    return {
      label: '重启中',
      tooltip: '正在重启应用',
      disabled: true,
      tone: 'busy' as const,
      Icon: Loader2,
    };
  }

  if (stage === 'error') {
    return {
      label: '更新失败',
      tooltip: '更新检查失败，点击重试',
      disabled: false,
      tone: 'error' as const,
      Icon: RefreshCw,
    };
  }

  return null;
};

export function UpdateEntry() {
  const updater = useUpdaterContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const entry = getEntryState(updater.stage, updater.progress);

  if (!entry) {
    return null;
  }

  const { Icon } = entry;
  const handleClick = () => {
    if (updater.stage === 'available') {
      setConfirmOpen(true);
      return;
    }

    if (updater.stage === 'error') {
      void updater.checkForUpdates({
        interactive: true,
        announceNoUpdate: true,
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
            disabled={entry.disabled}
            onClick={handleClick}
            className={cn(
              'h-7 gap-1.5 rounded-md px-2.5 text-[12px] shadow-none',
              'border border-transparent',
              entry.tone === 'available' && 'bg-[hsl(var(--sidebar-accent)/0.16)] text-[hsl(var(--sidebar-accent))] hover:bg-[hsl(var(--sidebar-accent)/0.24)] hover:text-[hsl(var(--sidebar-accent))]',
              entry.tone === 'busy' && 'text-foreground/58',
              entry.tone === 'error' && 'bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.16)] hover:text-[hsl(var(--destructive))]',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', entry.tone === 'busy' && 'animate-spin')} />
            <span>{entry.label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{entry.tooltip}</p>
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
