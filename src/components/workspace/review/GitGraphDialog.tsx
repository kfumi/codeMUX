import { AlertCircle, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import { formatErrorMessage } from '../../../lib/errorMessage';
import type { GitCommitGraphCommit } from '../../../lib/gitTypes';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../ui/dialog';
import { GitGraphPane } from './GitGraphPane';

interface GitGraphDialogProps {
  open: boolean;
  projectPath: string;
  onOpenChange: (open: boolean) => void;
}

const GIT_GRAPH_PAGE_SIZE = 50;

export function GitGraphDialog({ open, projectPath, onOpenChange }: GitGraphDialogProps) {
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  const loadInitialCommits = useCallback(async () => {
    setLoading(true);
    setLoadingMore(false);
    setRefreshing(false);
    loadingMoreRef.current = false;
    setErrorMessage(null);
    setCommits([]);
    setHasMore(false);
    setSelectedCommitHash(null);

    try {
      const result = await daemonFacade.git.getCommitGraph(projectPath, GIT_GRAPH_PAGE_SIZE, 0);
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (err) {
      setErrorMessage(formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    void loadInitialCommits();
  }, [loadInitialCommits, open]);

  const refreshCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing) return;
    setRefreshing(true);
    setErrorMessage(null);
    try {
      const result = await daemonFacade.git.getCommitGraph(projectPath, GIT_GRAPH_PAGE_SIZE, 0);
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (err) {
      setErrorMessage(formatErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [loading, loadingMore, projectPath, refreshing]);

  const loadMoreCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing || loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await daemonFacade.git.getCommitGraph(
        projectPath,
        GIT_GRAPH_PAGE_SIZE,
        commits.length,
      );
      setCommits((current) => [...current, ...result.commits]);
      setHasMore(result.hasMore);
    } catch (err) {
      setErrorMessage(formatErrorMessage(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [commits.length, hasMore, loading, loadingMore, projectPath, refreshing]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="z-[300]"
        closeClassName="hidden"
        data-testid="git-graph-dialog"
        className="h-[min(78vh,720px)] w-[min(1100px,calc(100vw-2rem))] max-w-5xl gap-0 overflow-hidden rounded-2xl border-border/70 bg-popover p-0"
      >
        <DialogTitle className="sr-only">Git 图谱</DialogTitle>
        <DialogDescription className="sr-only">查看当前仓库的 Git 图谱</DialogDescription>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="关闭"
            className="absolute right-2 top-2 z-30 size-7 bg-popover/80 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </DialogClose>

        {loading ? (
          <div className="flex h-full items-center justify-center bg-popover text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : errorMessage ? (
          <div className="flex h-full items-center justify-center bg-popover p-6">
            <div className="max-w-md rounded-xl border border-border bg-card p-4 text-ui-body text-foreground">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="break-words text-muted-foreground">{errorMessage}</p>
              </div>
            </div>
          </div>
        ) : (
          <GitGraphPane
            commits={commits}
            hasMore={hasMore}
            loadingMore={loadingMore}
            refreshing={refreshing}
            selectedCommitHash={selectedCommitHash}
            onSelectCommit={setSelectedCommitHash}
            onLoadMore={() => void loadMoreCommits()}
            onRefresh={() => void refreshCommits()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
