"use client";

import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react';
import { Check, Copy, Bug, GitFork, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { formatElapsed } from '@/components/agent/assistant-ui/RunningElapsed';
import { shellFacade } from '@/lib/facades/shell-facade';
import { cn } from '@/lib/utils';
import { TooltipHint } from '@/components/ui/tooltip';

export type MessageFooterStats = {
  durationMs?: number;
};

export type MessageFooterVariant = 'full' | 'minimal';

type MessageFooterProps = {
  timestamp?: number;
  stats?: MessageFooterStats;
  className?: string;
  revealOnHover?: boolean;
  sessionId?: string;
  sourceUuid?: string;
  canFork?: boolean;
  isForking?: boolean;
  onFork?: () => void | Promise<void>;
  /** `minimal` keeps copy + time only. Extra full-variant props are ignored. */
  variant?: MessageFooterVariant;
  /** When set, copy writes this string instead of using the chat runtime action bar. */
  copyText?: string;
};

export function MessageFooter({
  timestamp,
  stats,
  className,
  revealOnHover = false,
  sessionId,
  sourceUuid,
  canFork = false,
  isForking = false,
  onFork,
  variant = 'full',
  copyText,
}: MessageFooterProps) {
  const isMinimal = variant === 'minimal';
  const hasStats = !isMinimal && stats?.durationMs != null;
  const revealClass = revealOnHover
    ? 'opacity-0 transition-opacity duration-150 group-hover/message-row:opacity-100 group-focus-within/message-row:opacity-100'
    : undefined;
  const showDebug = !isMinimal && Boolean(sessionId);
  const showFork = !isMinimal && Boolean(canFork && onFork);
  const useRuntimeCopy = copyText == null;
  const actions = useRuntimeCopy
    ? (
      <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
        <MessageCopyButton />
        {showDebug && sessionId ? <DebugCopyButton sessionId={sessionId} sourceUuid={sourceUuid} /> : null}
        {showFork && onFork ? <ForkButton isForking={isForking} onFork={onFork} /> : null}
      </ActionBarPrimitive.Root>
    )
    : (
      <div className="flex items-center gap-1">
        {copyText.length > 0 ? <ExplicitCopyButton text={copyText} /> : null}
      </div>
    );

  if (!timestamp && !hasStats) {
    return (
      <div
        data-message-footer
        className={cn('mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/68', revealClass, className)}
      >
        {actions}
      </div>
    );
  }

  return (
    <div
      data-message-footer
      className={cn(
        isMinimal
          ? 'mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/68'
          : 'mt-4 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/68',
        revealClass,
        className,
      )}
    >
      {actions}
      {timestamp ? <FooterItem>{formatTime(timestamp)}</FooterItem> : null}
      {hasStats && stats?.durationMs != null ? (
        <FooterItem>耗时 {formatElapsed(stats.durationMs)}</FooterItem>
      ) : null}
    </div>
  );
}

function DebugCopyButton({ sessionId, sourceUuid }: { sessionId: string; sourceUuid?: string }) {
  const [isCopied, setIsCopied] = useState(false);

  const copyDebugPrompt = async () => {
    const logDirectory = await shellFacade.getLogDirectory();
    await navigator.clipboard.writeText(
      `请排查 CodeMUX 的问题。\n会话ID: ${sessionId}\n本轮对话ID: ${sourceUuid ?? '未知'}\n日志目录: ${logDirectory}`,
    );
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  };

  return (
    <TooltipHint content="复制排查问题提示词">
      <button
        type="button"
        onClick={() => void copyDebugPrompt()}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
          'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground',
        )}
        aria-label="复制排查问题提示词"
      >
        {isCopied ? <Check className="h-3 w-3" /> : <Bug className="h-3 w-3" />}
      </button>
    </TooltipHint>
  );
}

function ExplicitCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <TooltipHint content={copied ? '已复制' : '复制'}>
      <button
        type="button"
        aria-label="复制"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
          'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground',
        )}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </TooltipHint>
  );
}

function MessageCopyButton() {
  const isCopied = useAuiState((state) => state.message.isCopied);

  return (
    <TooltipHint content="复制">
      <ActionBarPrimitive.Copy
        copiedDuration={1500}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
          'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground',
        )}
        aria-label="复制"
      >
        {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </ActionBarPrimitive.Copy>
    </TooltipHint>
  );
}

function ForkButton({ isForking, onFork }: { isForking: boolean; onFork: () => void | Promise<void> }) {
  return (
    <TooltipHint content="从此回复创建分支">
      <button
        type="button"
        onClick={() => void onFork()}
        disabled={isForking}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
          'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground disabled:cursor-wait disabled:opacity-50',
        )}
        aria-label="从此回复创建分支"
      >
        {isForking ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitFork className="h-3 w-3" />}
      </button>
    </TooltipHint>
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

export function formatTime(timestamp: number) {
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
