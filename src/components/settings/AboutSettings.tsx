import { useEffect, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';

import { desktopBridge } from '@/lib/desktop-bridge';
import { shellFacade } from '@/lib/facades/shell-facade';
import { useUpdaterContext } from '@/features/update/UpdaterProvider';
import { getUpdateEntryView, getUpdatePercent, formatBytes } from '@/features/update/updateDisplay';
import { useHostCapabilities } from '@/hooks/useHostCapabilities';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface AppInfo {
  name: string;
  version: string;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export function AboutSettings() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [latestDialogOpen, setLatestDialogOpen] = useState(false);
  const [updateErrorDialogOpen, setUpdateErrorDialogOpen] = useState(false);
  const { stage, version, progress, error: updateError, checkForUpdates, startUpdate } = useUpdaterContext();
  // 自动更新是壳独占能力(与 UpdateEntry 同一判据):浏览器/移动形态隐藏入口。
  const capabilities = useHostCapabilities();
  const canUpdate = capabilities.has('updater');
  const isCheckingForUpdates = stage === 'checking';
  const isUpdateActive = stage === 'checking'
    || stage === 'downloading'
    || stage === 'installing'
    || stage === 'restarting';

  useEffect(() => {
    // 应用版本走壳桥 currentVersion(工单 09 终态);桥缺失(纯 Web)时保持占位符。
    desktopBridge?.currentVersion()
      .then((version) => {
        setInfo({ name: 'CodeMUX', version });
      })
      .catch(() => {});
  }, []);
  // 更新进度区:此前本页只在 stage 上把「检查更新」按钮置灰,downloading /
  // installing / restarting / error 一个都不渲染 —— 从关于页点「下载并安装」
  // 后确认框一关,界面零变化(而标题栏 UpdateEntry 只在非设置页渲染)。
  // 口径与 UpdateEntry 共用 updateDisplay,两处必须一致。
  const updateView = getUpdateEntryView(stage, progress, updateError);
  const showUpdateStatus = canUpdate && updateView !== null && stage !== 'available';
  const updatePercent = stage === 'downloading' ? getUpdatePercent(progress) : null;
  const downloadedBytes = progress?.downloadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? null;

  return (
    <div className="space-y-6">
      {/* App identity */}
      <div className="flex flex-col items-center gap-4 rounded-xl settings-tile p-6">
        <img src="/logo.png" alt="CodeMUX" className="h-16 w-16 rounded-2xl" />
        <div className="text-center">
          <h2 className="text-lg font-semibold text-foreground">
            {info?.name ?? 'CodeMUX'}
          </h2>
          <p className="text-sm text-muted-foreground">AI 编码工具聚合平台</p>
          {info?.version && (
            <span className="mt-2 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              v{info.version}
            </span>
          )}
        </div>
      </div>

      {/* Environment info */}
      <div className="flex flex-col gap-3">
        <label className="text-ui-compact font-medium text-muted-foreground">运行环境</label>
        <div className="rounded-xl settings-tile px-4 divide-y divide-border/40">
          <InfoRow label="应用版本" value={info?.version ?? '-'} />
          <InfoRow
            label="宿主形态"
            value={capabilities.form === 'desktop'
              ? 'Electron 桌面壳'
              : capabilities.form === 'mobile'
                ? '手机浏览器'
                : 'PC 浏览器'}
          />
          <InfoRow label="操作系统" value={getOSInfo()} />
          <InfoRow label="系统架构" value={getArchInfo()} />
        </div>
      </div>

      {/* 更新状态:下载/安装/重启进度 + 失败原因(此前本页完全没有反馈) */}
      {showUpdateStatus && updateView && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <label
              className={cn(
                'text-ui-compact font-medium',
                updateView.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {updateView.label}
            </label>
            {updatePercent !== null && (
              <span className="font-mono text-code text-foreground">{updatePercent}%</span>
            )}
          </div>
          {stage === 'downloading' && (
            <>
              <div
                role="progressbar"
                aria-label="更新下载进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={updatePercent ?? undefined}
                className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
              >
                {updatePercent === null ? (
                  // 总量未知(未收到 content-length):不确定态,不做假百分比。
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                ) : (
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-normal ease-motion-out"
                    style={{ width: `${updatePercent}%` }}
                  />
                )}
              </div>
              <span className="text-ui-meta text-muted-foreground">
                {totalBytes !== null
                  ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                  : `已下载 ${formatBytes(downloadedBytes)}`}
              </span>
            </>
          )}
          {updateView.tone === 'error' && updateView.detail && (
            <span className="text-ui-meta text-destructive [overflow-wrap:anywhere]">
              {updateView.detail}
            </span>
          )}
          {updateView.tone === 'error' && (
            <span className="text-ui-meta text-muted-foreground">
              完整原因见应用数据目录下的 logs/updater.log
            </span>
          )}
        </div>
      )}

      {/* Links */}
      <div className="flex flex-col gap-3">
        <label className="text-ui-compact font-medium text-muted-foreground">链接</label>
        <div className="flex gap-2">
          {canUpdate && (
            <Button
              variant="outline"
              size="sm"
              disabled={isUpdateActive}
              onClick={async () => {
                try {
                  const update = await checkForUpdates({
                    interactive: true,
                    announceNoUpdate: true,
                    throwOnError: true,
                  });

                  if (update) {
                    setUpdateConfirmOpen(true);
                    return;
                  }

                  setLatestDialogOpen(true);
                } catch {
                  setUpdateErrorDialogOpen(true);
                }
              }}
            >
              {isCheckingForUpdates ? '检查中...' : '检查更新'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              // 外链走壳桥 openExternal(main 侧 shell.openExternal,仅 http/https)。
              void shellFacade.openExternal('https://github.com/kfumi/codeMUX').catch(() => {});
            }}
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
            <ExternalLink className="h-3 w-3 opacity-50" />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={updateConfirmOpen}
        onOpenChange={setUpdateConfirmOpen}
        title={`安装更新 ${version ?? ''}？`}
        description="应用将下载新版本并在安装完成后重启。请先保存正在编辑的重要内容。"
        confirmLabel="下载并安装"
        cancelLabel="稍后"
        onConfirm={() => {
          void startUpdate();
        }}
      />

      <Dialog open={latestDialogOpen} onOpenChange={setLatestDialogOpen}>
        <DialogContent className="sm:max-w-95">
          <DialogHeader>
            <DialogTitle>已经是最新版本</DialogTitle>
            <DialogDescription>
              当前安装的 CodeMUX 已经是最新版本。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" onClick={() => setLatestDialogOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={updateErrorDialogOpen} onOpenChange={setUpdateErrorDialogOpen}>
        <DialogContent className="sm:max-w-95">
          <DialogHeader>
            <DialogTitle>检查更新失败</DialogTitle>
            <DialogDescription>
              暂时无法检查更新，请确认网络可访问 GitHub，并在桌面正式环境中重试。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" onClick={() => setUpdateErrorDialogOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getOSInfo(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  return '未知';
}

function getArchInfo(): string {
  const p = navigator.platform ?? '';
  if (p.includes('x64') || p.includes('x86_64') || p.includes('Win64')) return 'x86_64';
  if (p.includes('arm64') || p.includes('aarch64')) return 'ARM64';
  if (p.includes('x86')) return 'x86';
  return p || '未知';
}
