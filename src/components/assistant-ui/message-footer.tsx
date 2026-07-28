"use client";

import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, Bug, TriangleAlert, CircleX } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { ConversationTurnStatus } from '@/types/conversationTurn';

export type MessageFooterStats = {
  durationMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type MessageFooterProps = {
  timestamp?: number;
  stats?: MessageFooterStats;
  status?: Exclude<ConversationTurnStatus, 'running' | 'completed'>;
  statusReason?: string;
  className?: string;
  revealOnHover?: boolean;
  sessionId?: string;
  sourceUuid?: string;
};

export function MessageFooter({ timestamp, stats, status, statusReason, className, revealOnHover = false, sessionId, sourceUuid }: MessageFooterProps) {
  const hasStats =
    stats &&
    (stats.durationMs != null ||
      stats.inputTokens != null ||
      stats.outputTokens != null);
  const hasStatus = status !== undefined;
  const revealClass = revealOnHover
    ? 'opacity-0 transition-opacity duration-150 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100'
    : undefined;

  if (!timestamp && !hasStats && !hasStatus) {
    return (
      <div
        data-message-footer
        className={cn('mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/68', revealClass, className)}
      >
        <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
          <MessageCopyButton />
          {sessionId ? <DebugCopyButton sessionId={sessionId} sourceUuid={sourceUuid} /> : null}
        </ActionBarPrimitive.Root>
      </div>
    );
  }

  const totalInputTokens = stats?.inputTokens || 0;
  const allInputTokens =
    (stats?.inputTokens || 0) + (stats?.cacheReadTokens || 0) + (stats?.cacheCreationTokens || 0);
  const cacheHitRate =
    allInputTokens > 0 && (stats?.cacheReadTokens || 0) > 0
      ? ((stats?.cacheReadTokens || 0) / allInputTokens) * 100
      : null;

  return (
    <div
      data-message-footer
      className={cn(
        'mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/68',
        revealClass,
        className,
      )}
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
        <MessageCopyButton />
        {sessionId ? <DebugCopyButton sessionId={sessionId} sourceUuid={sourceUuid} /> : null}
      </ActionBarPrimitive.Root>

      {timestamp ? <FooterItem>{formatTime(timestamp)}</FooterItem> : null}
      {status ? <FooterStatus status={status} reason={statusReason} /> : null}
      {stats?.durationMs != null ? <FooterItem>耗时 {(stats.durationMs / 1000).toFixed(1)}s</FooterItem> : null}
      {stats?.outputTokens != null || totalInputTokens > 0 ? (
        <FooterItem>
          {totalInputTokens}+{stats?.outputTokens || 0} token
        </FooterItem>
      ) : null}
      {cacheHitRate != null ? <FooterItem>缓存命中 {cacheHitRate.toFixed(0)}%</FooterItem> : null}
    </div>
  );
}

function FooterStatus({
  status,
  reason,
}: {
  status: Exclude<ConversationTurnStatus, 'running' | 'completed'>;
  reason?: string;
}) {
  const label = status === 'interrupted' ? 'Interrupted' : 'Failed';
  const Icon = status === 'interrupted' ? TriangleAlert : CircleX;

  return (
    <FooterItem>
      <span className="inline-flex items-center gap-1" title={reason || undefined}>
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
    </FooterItem>
  );
}

function DebugCopyButton({ sessionId, sourceUuid }: { sessionId: string; sourceUuid?: string }) {
  const [isCopied, setIsCopied] = useState(false);

  const copyDebugPrompt = async () => {
    const logDirectory = await invoke<string>('get_log_directory');
    await navigator.clipboard.writeText(
      `请排查 CodeMUX 的问题。\n会话ID: ${sessionId}\n本轮对话ID: ${sourceUuid ?? '未知'}\n日志目录: ${logDirectory}`,
    );
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copyDebugPrompt()}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
        'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground',
      )}
      title="复制排查问题提示词"
      aria-label="复制排查问题提示词"
    >
      {isCopied ? <Check className="h-3 w-3" /> : <Bug className="h-3 w-3" />}
    </button>
  );
}

function MessageCopyButton() {
  const isCopied = useAuiState((state) => state.message.isCopied);

  return (
    <ActionBarPrimitive.Copy
      copiedDuration={1500}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
        'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground',
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
      <span className="text-muted-foreground/35">·</span>
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
