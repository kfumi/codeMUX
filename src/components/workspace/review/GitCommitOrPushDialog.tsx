import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronDown,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import { formatErrorMessage } from '../../../lib/errorMessage';
import type { GitRepositoryState } from '../../../lib/gitTypes';
import type { GitEnvironmentTotals } from '../../../stores/gitEnvironmentStore';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../ui/dialog';

/** 当前分支能否推送：非 detached、有分支名，且「没有上游（首次推送）或有领先提交」。 */
export function canPushRepository(state: GitRepositoryState | null): boolean {
  if (!state || state.detached || !state.currentBranch) return false;
  return !state.upstreamBranch || state.aheadCount > 0;
}

/** 摘要面板入口是否可用：有未提交改动，或可以推送。 */
export function canCommitOrPush(state: GitRepositoryState | null): boolean {
  if (!state) return false;
  return state.hasUncommittedChanges || canPushRepository(state);
}

type CommitDialogActionId = 'commit' | 'commitAndPush' | 'push';

function formatDelta(value: number): string {
  return value.toLocaleString('en-US');
}

/** 动作列表里选中项的快捷键提示：与平台一致（macOS ⌘↵ / 其它 Ctrl+↵）。 */
function commitShortcutLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent)) {
    return '⌘↵';
  }
  return 'Ctrl+↵';
}

interface GitCommitOrPushDialogProps {
  projectPath: string;
  state: GitRepositoryState | null;
  totals: GitEnvironmentTotals;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选择「推送」时改为打开推送确认弹窗（对照 ZCode：推送不直接执行）。 */
  onRequestPush: () => void;
  /** 提交/推送成功后回调（刷新摘要面环境信息等）。 */
  onCompleted: () => void;
}

export function GitCommitOrPushDialog({
  projectPath,
  state,
  totals,
  open,
  onOpenChange,
  onRequestPush,
  onCompleted,
}: GitCommitOrPushDialogProps) {
  const [message, setMessage] = useState('');
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [stagedCount, setStagedCount] = useState(0);
  const [unstagedCount, setUnstagedCount] = useState(0);
  const [selectedAction, setSelectedAction] = useState<CommitDialogActionId>('commit');
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const busy = generating || committing;
  const branchLabel = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';
  const canIncludeUnstaged = Boolean(state?.hasUncommittedChanges);
  const shouldIncludeUnstaged = includeUnstaged && canIncludeUnstaged;
  const canCommit = Boolean(state) && (state?.hasUncommittedChanges || stagedCount > 0);
  const canPush = canPushRepository(state);
  const stagedOnlyWithoutStaged = !shouldIncludeUnstaged && stagedCount === 0;
  const commitActionDisabled = busy || !canCommit || stagedOnlyWithoutStaged;
  const generateDisabled = busy || stagedOnlyWithoutStaged || !canCommit;
  const fileCount = shouldIncludeUnstaged ? stagedCount + unstagedCount : stagedCount;

  // 打开时拉一次已暂存 / 未暂存文件数：动作可用性与「包含未暂存」的文件计数都依赖它。
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setError(null);
    setSelectedAction('commit');
    Promise.all([
      daemonFacade.git.getStatusChanges(projectPath, 'staged').catch(() => []),
      daemonFacade.git.getStatusChanges(projectPath, 'unstaged').catch(() => []),
    ]).then(([staged, unstaged]) => {
      if (cancelled) return;
      setStagedCount(staged.length);
      setUnstagedCount(unstaged.length);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [message, open]);

  const actions = [
    {
      id: 'commit' as const,
      icon: <GitCommitHorizontal className="size-4" />,
      label: '提交',
      disabled: commitActionDisabled,
      pending: committing,
      run: () => runCommit(false),
    },
    {
      id: 'commitAndPush' as const,
      icon: <CloudUpload className="size-4" />,
      label: '提交并推送',
      disabled: commitActionDisabled,
      pending: committing,
      run: () => runCommit(true),
    },
    {
      id: 'push' as const,
      icon: <CloudUpload className="size-4" />,
      label: '推送',
      disabled: busy || !canPush,
      pending: false,
      run: onRequestPush,
    },
  ];

  // 选中的动作若变为不可用，自动落到第一个可用项（对照 ZCode 的状态机）。
  useEffect(() => {
    const current = actions.find((action) => action.id === selectedAction);
    if (current && !current.disabled) return;
    const firstEnabled = actions.find((action) => !action.disabled);
    if (firstEnabled && firstEnabled.id !== selectedAction) {
      setSelectedAction(firstEnabled.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitActionDisabled, canPush, busy, selectedAction]);

  const triggerSelected = useCallback(() => {
    const current = actions.find((action) => action.id === selectedAction);
    if (!current || current.disabled) return;
    current.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAction, commitActionDisabled, canPush, busy, message, shouldIncludeUnstaged]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      setSelectedAction((currentId) => {
        const enabled = actions.filter((action) => !action.disabled);
        if (enabled.length === 0) return currentId;
        const index = enabled.findIndex((action) => action.id === currentId);
        const nextIndex = (index + direction + enabled.length) % enabled.length;
        return enabled[nextIndex]?.id ?? currentId;
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [commitActionDisabled, canPush, busy],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const target = event.target as HTMLElement;
        // 输入框里回车只换行；其余位置回车触发选中动作。
        if (target.tagName === 'TEXTAREA') return;
        event.preventDefault();
        triggerSelected();
      }
    },
    [moveSelection, triggerSelected],
  );

  async function handleGenerate() {
    if (!projectPath || generateDisabled) return;
    setError(null);
    setGenerating(true);
    try {
      // 生成只读已暂存 diff；勾选「包含未暂存」却没有暂存内容时先全量暂存。
      if (shouldIncludeUnstaged && stagedCount === 0) {
        await daemonFacade.git.stageStatusChanges(projectPath);
        const staged = await daemonFacade.git.getStatusChanges(projectPath, 'staged');
        setStagedCount(staged.length);
        setUnstagedCount(0);
      }
      const suggestion = await daemonFacade.git.generateCommitMessage(projectPath);
      setMessage(suggestion.message);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  async function runCommit(pushAfter: boolean) {
    if (!projectPath || busy || !canCommit) return;
    setError(null);
    setCommitting(true);
    try {
      if (shouldIncludeUnstaged) {
        await daemonFacade.git.stageStatusChanges(projectPath);
      }
      const finalMessage = message.trim()
        ? message
        : (await daemonFacade.git.generateCommitMessage(projectPath)).message;
      setMessage(finalMessage);
      await daemonFacade.git.commitChanges(projectPath, finalMessage);
      if (pushAfter) {
        await daemonFacade.git.pushBranch(projectPath);
      }
      setMessage('');
      onOpenChange(false);
      onCompleted();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="z-[300]"
        aria-describedby={undefined}
        closeClassName="hidden"
        data-testid="git-commit-or-push-dialog"
        className="w-[420px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-xl border border-border/70 bg-popover p-0 shadow-elevation"
      >
        <DialogTitle className="sr-only">提交或推送</DialogTitle>

        <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{branchLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </span>
          <span className="shrink-0 font-mono text-ui-caption tabular-nums">
            <span className="text-diff-added">+{formatDelta(totals.additions)}</span>
            <span className="ml-2 text-diff-removed">-{formatDelta(totals.deletions)}</span>
          </span>
        </div>

        <div className="px-4 pb-2">
          <div className="relative">
            <textarea
              ref={textareaRef}
              aria-label="提交信息"
              data-testid="git-commit-or-push-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="提交信息（留空将自动生成）"
              disabled={busy}
              rows={3}
              className="min-h-[6.5rem] w-full resize-none overflow-y-auto border-0 bg-transparent py-1 pr-8 text-sm leading-6 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="AI 生成提交信息"
              data-testid="git-commit-or-push-generate"
              onClick={() => void handleGenerate()}
              disabled={generateDisabled}
              className="absolute right-0 top-0.5 size-7 px-0 text-muted-foreground hover:text-foreground"
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </Button>
          </div>
        </div>

        <div className="px-2.5 pb-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={shouldIncludeUnstaged}
            data-testid="git-commit-or-push-include-unstaged"
            disabled={busy || !canIncludeUnstaged}
            onClick={() => setIncludeUnstaged((value) => !value)}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors',
              busy || !canIncludeUnstaged
                ? 'cursor-default text-muted-foreground'
                : 'cursor-pointer text-foreground hover:bg-foreground/8',
            )}
          >
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                shouldIncludeUnstaged
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-transparent',
              )}
            >
              <Check className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate">包含未暂存的更改</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
              {fileCount} 个文件
            </span>
          </button>
        </div>

        <div className="border-t border-border/50 px-2.5 py-2" onKeyDown={handleKeyDown}>
          {error ? <p className="px-2.5 py-1.5 text-xs text-destructive">{error}</p> : null}
          <div role="listbox" aria-label="提交或推送">
            {actions.map((action) => {
              const selected = action.id === selectedAction;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`git-commit-or-push-${action.id}`}
                  disabled={action.disabled}
                  onMouseEnter={() => !action.disabled && setSelectedAction(action.id)}
                  onClick={() => action.run()}
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-medium transition-colors',
                    action.disabled
                      ? 'cursor-default text-muted-foreground'
                      : selected
                        ? 'bg-foreground/8 text-foreground'
                        : 'text-foreground hover:bg-foreground/8',
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {action.pending ? <Loader2 className="size-4 animate-spin" /> : action.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{action.label}</span>
                  {selected ? (
                    <span className="shrink-0 font-mono text-ui-micro text-muted-foreground">
                      {commitShortcutLabel()}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
