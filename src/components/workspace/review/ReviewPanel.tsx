import { ChevronDown, ChevronUp, Trash2, Undo2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import { formatErrorMessage } from '../../../lib/errorMessage';
import {
  type CreatePullRequestResult,
  type GitPullRequestSuggestion,
  type GitRepositoryState,
  type GitStatusArea,
  type GitStatusChange,
} from '../../../lib/gitTypes';
import { cn } from '../../../lib/utils';
import { DiffView } from '../../preview/DiffView';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { TooltipHint } from '../../ui/tooltip';
import { GitBranchBar } from './GitBranchBar';
import { FileTypeIcon } from '../../assistant-ui/file-type-icon';

function displayPath(filePath: string, projectPath: string): string {
  const normalize = (path: string) => path
    .replace(/^\\\\\?\\UNC\\/i, '//')
    .replace(/^\\\\\?\\/i, '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  const root = normalize(projectPath);
  const normalized = normalize(filePath);
  return normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized;
}

function splitDisplayPath(filePath: string, projectPath: string) {
  const path = displayPath(filePath, projectPath);
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    return { name: path, directory: '' };
  }
  return {
    name: path.slice(slash + 1),
    directory: path.slice(0, slash + 1),
  };
}

function statusLabel(status: string) {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
}

type FileDetailState = {
  loading: boolean;
  error: string | null;
  change: GitStatusChange | null;
};

function detailKey(area: GitStatusArea, filePath: string) {
  return `${area}:${filePath}`;
}

export function ReviewPanel({ projectPath }: { projectPath: string }) {
  const [area, setArea] = useState<GitStatusArea>('unstaged');
  const [repositoryState, setRepositoryState] = useState<GitRepositoryState | null>(null);
  const [files, setFiles] = useState<GitStatusChange[]>([]);
  const [stagedFiles, setStagedFiles] = useState<GitStatusChange[]>([]);
  const [fileDetails, setFileDetails] = useState<Record<string, FileDetailState>>({});
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<{ type: 'single' | 'all'; filePath?: string; name?: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [prSuggestion, setPrSuggestion] = useState<GitPullRequestSuggestion | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [prBase, setPrBase] = useState('');
  const [prCreateError, setPrCreateError] = useState<string | null>(null);
  const [prResult, setPrResult] = useState<CreatePullRequestResult | null>(null);
  const lastBranchRef = useRef<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const [nextState, nextFiles, nextStagedFiles] = await Promise.all([
        daemonFacade.git.getRepositoryState(projectPath),
        daemonFacade.git.getStatusChanges(projectPath, area),
        daemonFacade.git.getStatusChanges(projectPath, 'staged'),
      ]);
      setRepositoryState(nextState);
      setFiles(nextFiles);
      setStagedFiles(nextStagedFiles);
      setFileDetails({});
      setExpandedPath((current) => (current && nextFiles.some((file) => file.path === current) ? current : null));
      // 分支切换后旧 suggestion 失效，清空避免误展示。
      if (lastBranchRef.current !== undefined && lastBranchRef.current !== nextState.currentBranch) {
        setPrSuggestion(null);
        setPrError(null);
        setPrCreateError(null);
        setPrResult(null);
        setPrBase('');
      }
      lastBranchRef.current = nextState.currentBranch;
    } catch (err) {
      setError(formatErrorMessage(err));
      setRepositoryState(null);
      setFiles([]);
      setStagedFiles([]);
      setFileDetails({});
      setExpandedPath(null);
    } finally {
      setLoading(false);
    }
  }, [area, projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (prBase || !repositoryState?.currentBranch) return;
    const fallback = repositoryState.branches.find(
      (branch) => !branch.current && (branch.name === 'main' || branch.name === 'master'),
    ) ?? repositoryState.branches.find((branch) => !branch.current);
    if (fallback) setPrBase(fallback.name);
  }, [prBase, repositoryState]);

  const toggleFile = useCallback((file: GitStatusChange) => {
    setExpandedPath((current) => (current === file.path ? null : file.path));
    const key = detailKey(area, file.path);
    const currentDetail = fileDetails[key];
    if (currentDetail?.change || currentDetail?.loading) {
      return;
    }

    setFileDetails((current) => ({
      ...current,
      [key]: { loading: true, error: null, change: null },
    }));
    void daemonFacade.git.getStatusChangeDetail(projectPath, area, file.path)
      .then((change) => {
        setFileDetails((current) => ({
          ...current,
          [key]: { loading: false, error: null, change },
        }));
      })
      .catch((err) => {
        setFileDetails((current) => ({
          ...current,
          [key]: { loading: false, error: formatErrorMessage(err), change: null },
        }));
      });
  }, [area, fileDetails, projectPath]);

  const runStageAction = useCallback(async (filePath?: string) => {
    if (!projectPath) return;
    const key = `${area}:${filePath ?? 'all'}`;
    setMutatingKey(key);
    setError(null);
    try {
      if (area === 'unstaged') {
        await daemonFacade.git.stageStatusChanges(projectPath, filePath);
      } else {
        await daemonFacade.git.unstageStatusChanges(projectPath, filePath);
      }
      await load();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [area, load, projectPath]);

  const runRevertAction = useCallback(async () => {
    if (!projectPath || !revertTarget) return;
    const filePath = revertTarget.type === 'single' ? revertTarget.filePath : undefined;
    const key = `${area}:revert:${filePath ?? 'all'}`;
    setMutatingKey(key);
    setError(null);
    try {
      await daemonFacade.git.revertStatusChanges(projectPath, area, filePath);
      setExpandedPath(null);
      await load();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
      setRevertTarget(null);
    }
  }, [area, load, projectPath, revertTarget]);

  const generateCommitMessage = useCallback(async () => {
    if (!projectPath) return;
    setMutatingKey('commit:generate');
    setCommitError(null);
    try {
      const suggestion = await daemonFacade.git.generateCommitMessage(projectPath);
      setCommitMessage(suggestion.message);
    } catch (err) {
      setCommitError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [projectPath]);

  const commitChanges = useCallback(async (options: { includeUnstaged: boolean; pushAfter: boolean }) => {
    if (!projectPath) return;
    setMutatingKey(options.pushAfter ? 'commit:push' : 'commit');
    setCommitError(null);
    try {
      if (options.includeUnstaged) {
        await daemonFacade.git.stageStatusChanges(projectPath);
      }
      const message = commitMessage.trim()
        ? commitMessage
        : (await daemonFacade.git.generateCommitMessage(projectPath)).message;
      setCommitMessage(message);
      await daemonFacade.git.commitChanges(projectPath, message);
      if (options.pushAfter) {
        await daemonFacade.git.pushBranch(projectPath);
      }
      setCommitMessage('');
      await load();
    } catch (err) {
      setCommitError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [commitMessage, load, projectPath]);

  const pushBranch = useCallback(async () => {
    if (!projectPath) return;
    setMutatingKey('push');
    setCommitError(null);
    try {
      await daemonFacade.git.pushBranch(projectPath);
      await load();
    } catch (err) {
      setCommitError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [load, projectPath]);

  const generatePullRequestDescription = useCallback(async () => {
    if (!projectPath) return;
    setMutatingKey('pr:generate');
    setPrError(null);
    try {
      const suggestion = await daemonFacade.git.generatePullRequestDescription(projectPath);
      setPrSuggestion(suggestion);
      setPrBase((current) => current || suggestion.base);
    } catch (err) {
      setPrError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [projectPath]);

  const createPullRequest = useCallback(async (request: { title: string; body: string; base: string }) => {
    if (!projectPath) return;
    setMutatingKey('pr:create');
    setPrCreateError(null);
    setPrResult(null);
    try {
      setPrResult(await daemonFacade.git.createPullRequest({ projectPath, ...request }));
    } catch (err) {
      setPrCreateError(formatErrorMessage(err));
    } finally {
      setMutatingKey(null);
    }
  }, [projectPath]);

  const totals = useMemo(() => files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  ), [files]);

  return (
    <div className="flex h-full flex-col">
      <GitBranchBar
        state={repositoryState}
        area={area}
        totals={totals}
        fileCount={files.length}
        loading={loading}
        mutating={mutatingKey != null}
        stagedCount={stagedFiles.length}
        commitMessage={commitMessage}
        commitError={commitError}
        generatingCommitMessage={mutatingKey === 'commit:generate'}
        committing={mutatingKey === 'commit' || mutatingKey === 'commit:push'}
        pushing={mutatingKey === 'push' || mutatingKey === 'commit:push'}
        prSuggestion={prSuggestion}
        prGenerating={mutatingKey === 'pr:generate'}
        prError={prError}
        prBase={prBase}
        prCreating={mutatingKey === 'pr:create'}
        prCreateError={prCreateError}
        prResult={prResult}
        onRefresh={() => void load()}
        onAreaChange={(nextArea) => {
          setExpandedPath(null);
          setArea(nextArea);
        }}
        onStageAll={() => void runStageAction()}
        onRevertAll={() => setRevertTarget({ type: 'all' })}
        onCommitMessageChange={setCommitMessage}
        onGenerateCommitMessage={() => void generateCommitMessage()}
        onCommit={(options) => void commitChanges(options)}
        onPush={() => void pushBranch()}
        onGeneratePullRequest={() => void generatePullRequestDescription()}
        onPrBaseChange={(base) => {
          setPrBase(base);
          setPrCreateError(null);
          setPrResult(null);
        }}
        onCreatePullRequest={(request) => void createPullRequest(request)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/25 py-2">
        {error ? (
          <div className="px-4 py-6 text-sm text-destructive">{error}</div>
        ) : files.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground/55">
            {loading ? '加载中...' : '暂无改动'}
          </div>
        ) : (
          files.map((file) => {
            const expanded = expandedPath === file.path;
            const detail = fileDetails[detailKey(area, file.path)];
            const { name, directory } = splitDisplayPath(file.path, projectPath);

            return (
              <div key={file.path} className="border-b border-border/18 last:border-b-0">
                <div
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-2 text-left transition-colors',
                    expanded ? 'bg-muted/52' : 'hover:bg-muted/28',
                  )}
                >
                  <button
                    onClick={() => toggleFile(file)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold',
                      file.status === 'added'
                        ? 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]'
                        : file.status === 'deleted'
                          ? 'bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]'
                          : 'bg-primary/10 text-primary',
                    )}>
                      {statusLabel(file.status)}
                    </span>
                    <FileTypeIcon filePath={file.path} className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground/88">
                      {name}
                      {directory && <span className="ml-2 text-sm text-muted-foreground/55">{directory}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-code text-[hsl(var(--success))]">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-code text-[hsl(var(--destructive))]">-{file.deletions}</span>
                    {expanded ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    )}
                  </button>
                  <TooltipHint content={area === 'unstaged' ? '暂存此文件' : '取消暂存此文件'}>
                    <button
                      type="button"
                      aria-label={`${area === 'unstaged' ? '暂存' : '取消暂存'} ${name}`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/72 transition-colors hover:bg-background/72 hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        void runStageAction(file.path);
                      }}
                    >
                      {area === 'unstaged' ? <Upload className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
                    </button>
                  </TooltipHint>
                  <TooltipHint content="还原此文件">
                    <button
                      type="button"
                      aria-label={`还原 ${name}`}
                      data-testid={`git-revert-${name}`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/72 transition-colors hover:bg-background/72 hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRevertTarget({ type: 'single', filePath: file.path, name });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  </TooltipHint>
                </div>
                {expanded && (
                  <div className="border-l-4 border-[hsl(var(--success))] bg-background">
                    {detail?.loading ? (
                      <div className="px-4 py-5 text-sm text-muted-foreground/60">加载 Diff...</div>
                    ) : detail?.error ? (
                      <div className="px-4 py-5 text-sm text-destructive">{detail.error}</div>
                    ) : detail?.change ? (
                      <DiffView
                        variant="inline"
                        oldContent={detail.change.originalContent ?? ''}
                        newContent={detail.change.currentContent}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border/25 px-4 text-xs text-muted-foreground/60">
        <span>{files.length} 个文件</span>
        <div className="flex gap-2 font-mono text-code">
          <span className="text-[hsl(var(--success))]">+{totals.additions}</span>
          <span className="text-[hsl(var(--destructive))]">-{totals.deletions}</span>
        </div>
      </div>
      <ConfirmDialog
        open={revertTarget != null}
        onOpenChange={(open) => !open && setRevertTarget(null)}
        title={revertTarget?.type === 'all' ? '还原全部修改' : `还原 ${revertTarget?.name ?? '文件'}`}
        description={area === 'unstaged'
          ? '此操作会丢弃未暂存修改，并删除未跟踪文件。'
          : '此操作会丢弃已暂存内容并还原工作区文件。'}
        confirmLabel="确认还原"
        variant="destructive"
        onConfirm={() => void runRevertAction()}
      />
    </div>
  );
}
