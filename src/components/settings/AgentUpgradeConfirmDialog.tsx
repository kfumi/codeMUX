import { AlertTriangle } from 'lucide-react';

import type { AgentInstallationReport } from '@/lib/tauri';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AgentInstallRow } from './AgentInstallRow';

interface AgentUpgradeConfirmDialogProps {
  open: boolean;
  report: AgentInstallationReport | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AgentUpgradeConfirmDialog({
  open,
  report,
  onConfirm,
  onCancel,
}: AgentUpgradeConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {report ? (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认升级</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1">
                <p>
                  检测到 {report.installs.length} 处安装,升级仅会更新默认入口那处。请确认后继续。
                </p>
                {report.isConflict && (
                  <p className="text-amber-600 dark:text-amber-400">检测到版本冲突</p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">安装位置</p>
            <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
              {report.installs.map((install, index) => (
                <AgentInstallRow
                  key={`${install.path}-${index}`}
                  install={install}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">将执行的命令</p>
            {report.command ? (
              <code className="block font-mono text-xs bg-muted/50 rounded px-2 py-1.5 break-all">
                {report.command}
              </code>
            ) : (
              <p className="text-xs text-muted-foreground">无法生成命令,将退到 npm 兜底</p>
            )}
          </div>

          {report.anchored === false && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>默认入口无法确定,将退到 npm 兜底</span>
            </div>
          )}

          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button variant="default" onClick={onConfirm}>
              确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
