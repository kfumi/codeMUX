import { ChevronDown, ChevronUp, FileText, RefreshCw, Undo2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { gitApi, type GitRepositoryState, type GitStatusArea, type GitStatusChange } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DiffView } from '../../preview/DiffView';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { GitBranchBar } from './GitBranchBar';
import { GitBranchDialog } from './GitBranchDialog';

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
  const [fileDetails, setFileDetails] = useState<Record<string, FileDetailState>>({});
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const [nextState, nextFiles] = await Promise.all([
        gitApi.getRepositoryState(projectPath),
        gitApi.getStatusChanges(projectPath, area),
      ]);
      setRepositoryState(nextState);
      setFiles(nextFiles);
      setFileDetails({});
      setExpandedPath((current) => (current && nextFiles.some((file) => file.path === current) ? current : null));
    } catch (err) {
      setError(String(err));
      setRepositoryState(null);
      setFiles([]);
      setFileDetails({});
      setExpandedPath(null);
    } finally {
      setLoading(false);
    }
  }, [area, projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

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
    void gitApi.getStatusChangeDetail(projectPath, area, file.path)
      .then((change) => {
        setFileDetails((current) => ({
          ...current,
          [key]: { loading: false, error: null, change },
        }));
      })
      .catch((err) => {
        setFileDetails((current) => ({
          ...current,
          [key]: { loading: false, error: String(err), change: null },
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
        await gitApi.stageStatusChanges(projectPath, filePath);
      } else {
        await gitApi.unstageStatusChanges(projectPath, filePath);
      }
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setMutatingKey(null);
    }
  }, [area, load, projectPath]);

  const checkoutBranch = useCallback(async (branchName: string) => {
    if (!projectPath) return;
    setMutatingKey(`branch:${branchName}`);
    setError(null);
    try {
      await gitApi.checkoutBranch(projectPath, branchName);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setMutatingKey(null);
    }
  }, [load, projectPath]);

  const createBranch = useCallback(async (branchName: string, checkout: boolean) => {
    if (!projectPath) return;
    setMutatingKey('branch:create');
    setBranchError(null);
    try {
      await gitApi.createBranch(projectPath, branchName, checkout);
      setBranchDialogOpen(false);
      await load();
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setMutatingKey(null);
    }
  }, [load, projectPath]);

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
        loading={loading}
        mutating={mutatingKey != null}
        onRefresh={() => void load()}
        onCheckout={(branchName) => void checkoutBranch(branchName)}
        onCreateBranch={() => setBranchDialogOpen(true)}
      />
      <GitBranchDialog
        open={branchDialogOpen}
        loading={mutatingKey === 'branch:create'}
        error={branchError}
        onOpenChange={setBranchDialogOpen}
        onCreate={(branchName, checkout) => void createBranch(branchName, checkout)}
      />
      <div className="flex h-15 shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={area}
            onValueChange={(value) => {
              setExpandedPath(null);
              setArea(value as GitStatusArea);
            }}
          >
            <SelectTrigger
              className="h-9 w-34 rounded-lg border-border/45 bg-background/92 px-3 text-sm shadow-sm"
              aria-label="选择审查范围"
            >
              <SelectValue placeholder="审查范围" />
            </SelectTrigger>
            <SelectContent align="start" className="z-260">
              <SelectItem value="unstaged">未暂存</SelectItem>
              <SelectItem value="staged">已暂存</SelectItem>
            </SelectContent>
          </Select>

          <button
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border/42 bg-background/80 px-2.5 text-xs text-foreground/82 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void runStageAction()}
            disabled={loading || files.length === 0 || mutatingKey != null}
            aria-label={area === 'unstaged' ? '全部暂存' : '全部取消暂存'}
            title={area === 'unstaged' ? '全部暂存' : '全部取消暂存'}
          >
            {area === 'unstaged' ? <Upload className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
            <span className="hidden xl:inline">{area === 'unstaged' ? '全部暂存' : '全部取消暂存'}</span>
          </button>
        </div>

        <button
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          刷新
        </button>
      </div>

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
                    'flex w-full items-center gap-2 px-4 py-2 text-left transition-colors',
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
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground/55" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground/88">
                      {name}
                      {directory && <span className="ml-2 text-sm text-muted-foreground/55">{directory}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-sm text-[hsl(var(--success))]">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-sm text-[hsl(var(--destructive))]">-{file.deletions}</span>
                    {expanded ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`${area === 'unstaged' ? '暂存' : '取消暂存'} ${name}`}
                    title={area === 'unstaged' ? '暂存此文件' : '取消暂存此文件'}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/72 transition-colors hover:bg-background/72 hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      void runStageAction(file.path);
                    }}
                  >
                    {area === 'unstaged' ? <Upload className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {expanded && (
                  <div className="border-l-4 border-[hsl(var(--success))] bg-background">
                    {detail?.loading ? (
                      <div className="px-4 py-5 text-sm text-muted-foreground/60">加载 Diff...</div>
                    ) : detail?.error ? (
                      <div className="px-4 py-5 text-sm text-destructive">{detail.error}</div>
                    ) : detail?.change ? (
                      <DiffView
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
        <div className="flex gap-2 font-mono">
          <span className="text-[hsl(var(--success))]">+{totals.additions}</span>
          <span className="text-[hsl(var(--destructive))]">-{totals.deletions}</span>
        </div>
      </div>
    </div>
  );
}
