import { GitBranch, Tag } from 'lucide-react';

import type { GitGraphRef } from '../../../lib/gitGraphLayout';

export function getShortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function getRefIcon(ref: GitGraphRef, className = 'size-3') {
  if (ref.kind === 'tag') {
    return <Tag className={className} />;
  }
  return <GitBranch className={className} />;
}

export function formatCommitTime(timestampMs: number | null, locale?: string): string {
  if (!timestampMs) {
    return '';
  }

  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}

/**
 * 泳道配色：从既有语义 token 里取四档循环。用 `hsl(var(--token))`（token 是
 * 裸 HSL 三元组）而不是写死的 hex，暗色/换肤都自动跟随。
 */
const LANE_COLOR_VARS = ['--primary', '--diff-added', '--warning', '--diff-removed'] as const;

export function laneColor(laneIndex: number): string {
  const varName = LANE_COLOR_VARS[laneIndex % LANE_COLOR_VARS.length]!;
  return `hsl(var(${varName}))`;
}
