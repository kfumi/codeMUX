import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/utils';

interface MessageFooterProps {
  content: string;
  timestamp?: number;
  durationMs?: number;
  sourceUuid?: string;
  align?: 'start' | 'end';
}

export function MessageFooter({
  content,
  timestamp,
  durationMs,
  sourceUuid,
  align = 'start',
}: MessageFooterProps) {
  const [isCopied, setIsCopied] = useState(false);

  const copyMessage = async () => {
    if (!content || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the mobile browser.
    }
  };

  return (
    <div
      data-message-footer
      data-source-uuid={sourceUuid}
      className={cn(
        'mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/68',
        align === 'end' && 'justify-end',
      )}
    >
      <button
        type="button"
        onClick={() => void copyMessage()}
        disabled={!content}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="复制"
      >
        {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      {timestamp != null ? <FooterItem>{formatMessageTime(timestamp)}</FooterItem> : null}
      {durationMs != null ? <FooterItem>耗时 {(durationMs / 1000).toFixed(1)}s</FooterItem> : null}
    </div>
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

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  const time = `${hh}:${mm}`;

  const isSameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();

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
