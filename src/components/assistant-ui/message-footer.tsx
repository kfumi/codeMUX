"use client";

import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';

export type MessageFooterStats = {
  durationMs?: number;
  numTurns?: number;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type MessageFooterProps = {
  timestamp?: number;
  stats?: MessageFooterStats;
  className?: string;
};

export function MessageFooter({ timestamp, stats, className }: MessageFooterProps) {
  const hasStats =
    stats &&
    (stats.durationMs != null ||
      stats.numTurns != null ||
      stats.costUsd != null ||
      stats.inputTokens != null ||
      stats.outputTokens != null);

  if (!timestamp && !hasStats) {
    return (
      <div className={cn('mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/40', className)}>
        <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
          <MessageCopyButton />
        </ActionBarPrimitive.Root>
      </div>
    );
  }

  const totalInputTokens =
    (stats?.inputTokens || 0) + (stats?.cacheReadTokens || 0) + (stats?.cacheCreationTokens || 0);
  const cacheHitRate =
    totalInputTokens > 0 && (stats?.cacheReadTokens || 0) > 0
      ? ((stats?.cacheReadTokens || 0) / totalInputTokens) * 100
      : null;

  return (
    <div
      className={cn(
        'mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/40',
        className,
      )}
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
        <MessageCopyButton />
      </ActionBarPrimitive.Root>

      {timestamp ? <FooterItem>{formatTime(timestamp)}</FooterItem> : null}
      {stats?.durationMs != null ? <FooterItem>耗时 {(stats.durationMs / 1000).toFixed(1)}s</FooterItem> : null}
      {stats?.numTurns != null ? <FooterItem>轮次 {stats.numTurns}</FooterItem> : null}
      {stats?.costUsd != null ? <FooterItem>${stats.costUsd.toFixed(4)}</FooterItem> : null}
      {stats?.outputTokens != null || totalInputTokens > 0 ? (
        <FooterItem>
          {totalInputTokens}+{stats?.outputTokens || 0} token
        </FooterItem>
      ) : null}
      {cacheHitRate != null ? <FooterItem>缓存命中 {cacheHitRate.toFixed(0)}%</FooterItem> : null}
    </div>
  );
}

function MessageCopyButton() {
  const isCopied = useAuiState((state) => state.message.isCopied);

  return (
    <ActionBarPrimitive.Copy
      copiedDuration={1500}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
        'text-muted-foreground/35 hover:bg-muted/40 hover:text-muted-foreground',
      )}
      title="复制"
      aria-label="复制"
    >
      {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </ActionBarPrimitive.Copy>
  );
}

function FooterItem({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground/20">·</span>
      <span className="tabular-nums">{children}</span>
    </>
  );
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  const time = `${hh}:${mm}`;

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(date, now)) {
    return time;
  }

  if (isSameDay(date, yesterday)) {
    return `昨天 ${time}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}-${day} ${time}`;
  }

  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day} ${time}`;
}
