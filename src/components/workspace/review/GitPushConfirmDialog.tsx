import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowUpFromLine, GitBranch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import { formatErrorMessage } from '../../../lib/errorMessage';
import type { GitRepositoryState } from '../../../lib/gitTypes';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../ui/dialog';
import { canPushRepository } from './GitCommitOrPushDialog';

interface GitPushConfirmDialogProps {
  projectPath: string;
  state: GitRepositoryState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 推送成功后回调（刷新摘要面环境信息等）。 */
  onCompleted: () => void;
}

/** 推送前的确认弹窗：核对分支/远程/同步状态后再推送，对照 ZCode 的 GitPushDialog。 */
export function GitPushConfirmDialog({
  projectPath,
  state,
  open,
  onOpenChange,
  onCompleted,
}: GitPushConfirmDialogProps) {
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);

  const branchLabel = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';
  const upstreamLabel = state?.upstreamBranch ?? null;
  const aheadCount = state?.aheadCount ?? 0;
  const canPush = canPushRepository(state);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setErrorCopied(false);
  }, [open]);

  const handleCopyError = useCallback(() => {
    if (!error) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      toast('复制错误信息失败：剪贴板不可用');
      return;
    }
    navigator.clipboard.writeText(error).then(
      () => {
        setErrorCopied(true);
        window.setTimeout(() => setErrorCopied(false), 1500);
      },
      (copyError: unknown) => toast(`复制错误信息失败：${formatErrorMessage(copyError)}`),
    );
  }, [error]);

  async function handlePush() {
    if (!projectPath || pushing || !canPush) return;
    setError(null);
    setPushing(true);
    try {
      await daemonFacade.git.pushBranch(projectPath);
      toast(`已推送到 ${upstreamLabel ?? branchLabel}`);
      onOpenChange(false);
      onCompleted();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setPushing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="z-[300]"
        data-testid="git-push-confirm-dialog"
        className="w-[420px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-xl border border-border/70 bg-popover p-0 shadow-elevation"
      >
        <div className="px-5 pb-1 pt-5">
          <DialogTitle className="text-ui-title font-medium text-foreground">推送更改</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">
            {upstreamLabel
              ? '将当前分支最新提交推送到远程分支。'
              : '首次推送会把当前分支发布到远程并设置 upstream。'}
          </DialogDescription>
        </div>

        <div className="space-y-3 px-5 py-4">
          {!error ? (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="text-xs font-medium text-foreground">分支</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{branchLabel}</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2.5">
                <span className="shrink-0 text-xs font-medium text-foreground">远程分支</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {upstreamLabel ?? '首次推送会自动为当前分支建立上游分支'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2.5">
                <span className="shrink-0 text-xs font-medium text-foreground">同步状态</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  领先 {aheadCount} 个提交
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2.5">
                <span className="shrink-0 text-xs font-medium text-foreground">后续步骤</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowUpFromLine className="size-3.5" />
                  推送
                </span>
              </div>
            </div>
          ) : null}

          {!canPush ? (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>当前分支没有需要推送的提交。</span>
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>推送失败，请检查错误详情。</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">错误详情</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={handleCopyError}
                  >
                    {errorCopied ? '已复制' : '复制错误信息'}
                  </Button>
                </div>
                <textarea
                  readOnly
                  aria-label="推送错误详情"
                  data-testid="git-push-confirm-error"
                  value={error}
                  className="max-h-56 min-h-24 w-full resize-none overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/50 px-3 py-2 font-mono text-code text-foreground"
                />
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className="flex-row justify-end gap-2 border-t border-border/50 px-5 py-3">
          {error ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pushing}
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pushing}
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="git-push-confirm-submit"
                disabled={pushing || !canPush}
                onClick={() => void handlePush()}
              >
                {pushing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                推送
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
