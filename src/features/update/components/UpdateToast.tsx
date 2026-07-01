import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import type { UpdateProgress, UpdateStage } from '../hooks/useUpdater';
import { useUpdaterContext } from '../UpdaterProvider';

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
};

const getProgressPercent = (downloadedBytes: number, totalBytes: number | null) => {
  if (!totalBytes || totalBytes <= 0) {
    return null;
  }

  return `${Math.round((downloadedBytes / totalBytes) * 100)}%`;
};

const getDownloadSummary = (progress?: UpdateProgress) => {
  const downloadedBytes = progress?.downloadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? null;
  const percent = getProgressPercent(downloadedBytes, totalBytes);
  const sizeText = totalBytes === null
    ? formatBytes(downloadedBytes)
    : `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`;

  return {
    percent,
    sizeText,
  };
};

export interface UpdateToastContentProps {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
  onDismiss: () => void;
  onStartUpdate: () => void;
  onRetry: () => void;
}

export function UpdateToastContent({
  stage,
  version,
  progress,
  error,
  onDismiss,
  onStartUpdate,
  onRetry,
}: UpdateToastContentProps) {
  if (stage === 'idle') {
    return null;
  }

  let title = '';
  let description: string | null = null;
  let actions: ReactNode = null;
  let progressPercent: string | null = null;
  let progressSizeText: string | null = null;

  if (stage === 'checking') {
    title = '正在检查更新';
  }

  if (stage === 'available') {
    title = '发现新版本';
    description = version ?? null;
    actions = (
      <>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          稍后
        </Button>
        <Button size="sm" onClick={onStartUpdate}>
          立即更新
        </Button>
      </>
    );
  }

  if (stage === 'latest') {
    title = '已经是最新版本';
    actions = (
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        关闭
      </Button>
    );
  }

  if (stage === 'downloading') {
    title = '正在下载更新';
    const summary = getDownloadSummary(progress);
    progressPercent = summary.percent;
    progressSizeText = summary.sizeText;
  }

  if (stage === 'installing') {
    title = '正在安装更新';
  }

  if (stage === 'restarting') {
    title = '正在重启应用';
  }

  if (stage === 'error') {
    title = '更新失败';
    description = error ?? '未知错误';
    actions = (
      <>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
        >
          关闭
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onRetry}
        >
          重试
        </Button>
      </>
    );
  }

  return (
    <section
      aria-live="polite"
      role="status"
      className="fixed left-1/2 top-4 z-50 flex w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2 flex-col gap-3 rounded-lg border border-border bg-background/98 p-4 shadow-[0_16px_48px_-24px_hsl(var(--foreground)/0.45)] backdrop-blur supports-[backdrop-filter]:bg-background/92"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {stage === 'downloading' ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            {progressPercent ? <p>{progressPercent}</p> : null}
            <p>{progressSizeText}</p>
          </div>
        ) : description ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>{description}</p>
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

export function UpdateToast() {
  const updater = useUpdaterContext();

  return (
    <UpdateToastContent
      stage={updater.stage}
      version={updater.version}
      progress={updater.progress}
      error={updater.error}
      onDismiss={updater.resetToIdle}
      onStartUpdate={updater.startUpdate}
      onRetry={() => {
        void updater.checkForUpdates({
          interactive: true,
          announceNoUpdate: true,
        });
      }}
    />
  );
}
