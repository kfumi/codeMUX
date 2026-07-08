import { useEffect, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { getName, getVersion, getTauriVersion } from '@tauri-apps/api/app';

import { useUpdaterContext } from '@/features/update/UpdaterProvider';

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
  tauriVersion: string;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-foreground/60">{label}</span>
      <span className="text-sm font-medium text-foreground/90">{value}</span>
    </div>
  );
}

export function AboutSettings() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [latestDialogOpen, setLatestDialogOpen] = useState(false);
  const [updateErrorDialogOpen, setUpdateErrorDialogOpen] = useState(false);
  const { stage, version, checkForUpdates, startUpdate } = useUpdaterContext();
  const isCheckingForUpdates = stage === 'checking';
  const isUpdateActive = stage === 'checking'
    || stage === 'downloading'
    || stage === 'installing'
    || stage === 'restarting';

  useEffect(() => {
    Promise.all([getName(), getVersion(), getTauriVersion()])
      .then(([name, version, tauriVersion]) => {
        setInfo({ name, version, tauriVersion });
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      {/* App identity */}
      <div className="flex flex-col items-center gap-4 rounded-xl bg-muted/40 p-6">
        <img src="/logo.png" alt="CodeMUX" className="h-16 w-16 rounded-2xl" />
        <div className="text-center">
          <h2 className="text-lg font-semibold text-foreground/90">
            {info?.name ?? 'CodeMUX'}
          </h2>
          <p className="text-sm text-foreground/60">AI 编码工具聚合平台</p>
          {info?.version && (
            <span className="mt-2 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              v{info.version}
            </span>
          )}
        </div>
      </div>

      {/* Environment info */}
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">运行环境</label>
        <div className="rounded-xl bg-muted/40 px-4 divide-y divide-border/40">
          <InfoRow label="应用版本" value={info?.version ?? '-'} />
          <InfoRow label="Tauri 版本" value={info?.tauriVersion ?? '-'} />
          <InfoRow label="操作系统" value={getOSInfo()} />
          <InfoRow label="系统架构" value={getArchInfo()} />
        </div>
      </div>

      {/* Links */}
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">链接</label>
        <div className="flex gap-2">
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
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              import('@tauri-apps/plugin-shell').then(({ open }) => {
                open('https://github.com/kfumi/codeMUX');
              }).catch(() => {});
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
              暂时无法检查更新，请稍后再试。
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
  // In Tauri, navigator.platform is still available
  const p = navigator.platform ?? '';
  if (p.includes('x64') || p.includes('x86_64') || p.includes('Win64')) return 'x86_64';
  if (p.includes('arm64') || p.includes('aarch64')) return 'ARM64';
  if (p.includes('x86')) return 'x86';
  return p || '未知';
}
