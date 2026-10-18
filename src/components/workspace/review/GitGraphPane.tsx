import { GitGraph as GitGraphIcon, GitMerge, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState, type UIEvent } from 'react';

import type { GitCommitGraphCommit } from '../../../lib/gitTypes';
import { layoutGitGraph, type GitGraphLayoutPath } from '../../../lib/gitGraphLayout';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { GitGraphCommitDetail } from './GitGraphCommitDetail';
import { formatCommitTime, getRefIcon, getShortHash, laneColor } from './gitGraphDisplay';

interface GitGraphPaneProps {
  commits: readonly GitCommitGraphCommit[];
  hasMore?: boolean;
  loadingMore?: boolean;
  refreshing?: boolean;
  selectedCommitHash: string | null;
  onSelectCommit: (hash: string) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
}

const NODE_RADIUS = 4;
const SELECTED_NODE_RADIUS = 4.5;
const SELECTED_RING_RADIUS = 6;
const LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
const GRAPH_COLUMN_MIN_WIDTH_PX = 56;
const TABLE_COLUMNS = 'minmax(220px,1fr) 120px 104px 76px';

function isPathRelated(path: GitGraphLayoutPath, hash: string | null): boolean {
  return Boolean(hash && path.relatedHashes.includes(hash));
}

export function GitGraphPane({
  commits,
  hasMore = false,
  loadingMore = false,
  refreshing = false,
  selectedCommitHash,
  onSelectCommit,
  onLoadMore,
  onRefresh,
}: GitGraphPaneProps) {
  const [hoveredCommitHash, setHoveredCommitHash] = useState<string | null>(null);
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const layout = useMemo(() => layoutGitGraph(commits), [commits]);
  const highlightedHash = hoveredCommitHash;
  const graphColumnWidth = Math.max(layout.width + 12, GRAPH_COLUMN_MIN_WIDTH_PX);
  const graphHeight = layout.height + layout.rowHeight;
  const expandedCommit = commits.find((commit) => commit.hash === expandedCommitHash) ?? null;

  const handleGraphScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!hasMore || loadingMore || !onLoadMore) return;
      const target = event.currentTarget;
      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceToBottom <= LOAD_MORE_SCROLL_THRESHOLD_PX) {
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border/60 bg-[hsl(var(--surface-2))]/60 px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitGraphIcon className="size-3.5 text-foreground" />
            <h2 className="truncate text-ui-body font-medium">Git 图谱</h2>
          </div>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={refreshing}
              aria-label="刷新 Git 图谱"
              className="mr-7 text-muted-foreground hover:text-foreground"
              onClick={onRefresh}
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </Button>
          ) : null}
        </div>
      </div>

      {commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GitGraphIcon className="mx-auto size-8 text-foreground-tertiary" />
            <p className="mt-3 text-ui-body font-medium text-foreground">暂无提交</p>
            <p className="mt-1 text-ui-body text-muted-foreground">当前仓库还没有提交历史。</p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" onScroll={handleGraphScroll}>
          <div
            className="grid min-w-[720px]"
            style={{
              gridTemplateColumns: `minmax(${GRAPH_COLUMN_MIN_WIDTH_PX}px, ${graphColumnWidth}px) minmax(0, 1fr)`,
            }}
          >
            <div className="border-b border-r border-border/60 bg-[hsl(var(--surface-2))]/60 px-3 py-2 text-xs font-medium text-muted-foreground">
              图
            </div>
            <div
              className="grid border-b border-border/60 bg-[hsl(var(--surface-2))]/60 text-xs font-medium text-muted-foreground"
              style={{ gridTemplateColumns: TABLE_COLUMNS }}
            >
              <div className="border-r border-border/60 px-3 py-2">描述</div>
              <div className="border-r border-border/60 px-3 py-2">日期</div>
              <div className="border-r border-border/60 px-3 py-2">作者</div>
              <div className="px-3 py-2">提交</div>
            </div>

            <div className="relative border-r border-border/60" style={{ height: graphHeight }}>
              <svg
                className="absolute inset-0 overflow-visible"
                width={graphColumnWidth}
                height={graphHeight}
                viewBox={`0 0 ${graphColumnWidth} ${graphHeight}`}
                role="img"
                aria-label="Git 提交图"
              >
                {layout.paths.map((path) => (
                  <path
                    key={path.id}
                    d={path.path}
                    fill="none"
                    strokeWidth={2}
                    stroke={laneColor(path.laneIndex)}
                    className={cn(
                      'transition-opacity',
                      highlightedHash && !isPathRelated(path, highlightedHash)
                        ? 'opacity-30'
                        : isPathRelated(path, highlightedHash)
                          ? 'opacity-100'
                          : 'opacity-55',
                    )}
                  />
                ))}
                {layout.rows.map((row) => {
                  const isSelected = row.commit.hash === selectedCommitHash;
                  const isHovered = row.commit.hash === hoveredCommitHash;
                  return (
                    <g key={row.commit.hash}>
                      <circle
                        cx={row.x}
                        cy={row.y}
                        r={isSelected ? SELECTED_NODE_RADIUS : NODE_RADIUS}
                        fill={laneColor(row.laneIndex)}
                        stroke="hsl(var(--background))"
                        strokeWidth={2}
                        className={cn(
                          'transition-all',
                          highlightedHash && !isSelected && !isHovered && 'opacity-80',
                        )}
                      />
                      {isSelected ? (
                        <circle
                          cx={row.x}
                          cy={row.y}
                          r={SELECTED_RING_RADIUS}
                          fill="none"
                          strokeWidth={1}
                          stroke={laneColor(row.laneIndex)}
                          className="opacity-85"
                        />
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="min-w-0">
              {layout.rows.map((row) => {
                const isSelected = row.commit.hash === selectedCommitHash;
                const isHovered = row.commit.hash === hoveredCommitHash;
                const commitTime = formatCommitTime(row.commit.authoredAtMs);
                return (
                  <button
                    key={row.commit.hash}
                    type="button"
                    style={{ gridTemplateColumns: TABLE_COLUMNS, height: layout.rowHeight }}
                    className={cn(
                      'grid w-full min-w-0 items-center border-y border-transparent text-left transition-colors',
                      'hover:bg-foreground/6 focus-visible:bg-foreground/6 focus-visible:outline-none',
                      isSelected && 'border-b-border/60 bg-[hsl(var(--accent-bg))]',
                      isSelected && row.rowIndex > 0 && 'border-t-border/60',
                      isHovered && !isSelected && 'bg-foreground/5',
                    )}
                    onClick={() => {
                      onSelectCommit(row.commit.hash);
                      setExpandedCommitHash((current) =>
                        current === row.commit.hash ? null : row.commit.hash,
                      );
                    }}
                    onMouseEnter={() => setHoveredCommitHash(row.commit.hash)}
                    onMouseLeave={() => setHoveredCommitHash(null)}
                  >
                    <span className="min-w-0 px-3">
                      <span className="flex min-w-0 items-center gap-2">
                        {row.commit.refs.length > 0 ? (
                          <span className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">
                            {row.commit.refs.slice(0, 4).map((ref) => (
                              <span
                                key={`${row.commit.hash}:${ref.name}`}
                                className={cn(
                                  'inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-ui-micro text-muted-foreground',
                                  ref.kind === 'head' &&
                                    'border-primary bg-[hsl(var(--accent-bg))] text-foreground',
                                  ref.kind === 'tag' && 'border-[hsl(var(--diff-added))]',
                                )}
                              >
                                {getRefIcon(ref, 'size-2.5')}
                                <span className="max-w-32 truncate">{ref.name}</span>
                              </span>
                            ))}
                          </span>
                        ) : null}
                        <span className="truncate text-xs text-foreground">
                          {row.commit.subject || getShortHash(row.commit.hash)}
                        </span>
                        {row.commit.parents.length > 1 ? (
                          <GitMerge className="size-3 shrink-0 text-[hsl(var(--warning))]" />
                        ) : null}
                      </span>
                    </span>
                    <span className="truncate border-l border-transparent px-3 text-xs text-muted-foreground">
                      {commitTime}
                    </span>
                    <span className="truncate border-l border-transparent px-3 text-xs text-muted-foreground">
                      {row.commit.authorName ?? '-'}
                    </span>
                    <span className="truncate border-l border-transparent px-3 font-mono text-ui-micro text-muted-foreground">
                      {getShortHash(row.commit.hash)}
                    </span>
                  </button>
                );
              })}
              {hasMore && onLoadMore ? (
                <div className="flex h-10 items-center border-b border-border/60 px-3">
                  <button
                    type="button"
                    disabled={loadingMore}
                    className="w-full rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground disabled:cursor-default disabled:opacity-60"
                    onClick={onLoadMore}
                  >
                    {loadingMore ? '正在加载…' : '加载更多提交'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {expandedCommit ? <GitGraphCommitDetail commit={expandedCommit} /> : null}
    </section>
  );
}
