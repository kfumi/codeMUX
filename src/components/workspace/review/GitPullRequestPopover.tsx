import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, Copy } from 'lucide-react';

import type { GitPullRequestSuggestion } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';

interface GitPullRequestPopoverProps {
  trigger: ReactNode;
  branch: string | null;
  suggestion: GitPullRequestSuggestion | null;
  generating: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerate: () => void;
}

export function GitPullRequestPopover({
  trigger,
  branch,
  suggestion,
  generating,
  error,
  open,
  onOpenChange,
  onGenerate,
}: GitPullRequestPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (suggestion) {
      setTitle(suggestion.title);
      setBody(suggestion.body);
      setCopied(false);
    }
  }, [suggestion]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [body, open]);

  const copySuggestion = async () => {
    if (!title.trim() && !body.trim()) return;
    try {
      await navigator.clipboard.writeText(`${title}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默失败，用户仍可手动复制。
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[420px] max-w-[calc(100vw-24px)] rounded-lg border border-border/70 bg-popover/98 p-3 shadow-[0_22px_58px_-34px_hsl(var(--surface-shadow-strong)/0.42),0_0_0_1px_hsl(var(--background)/0.7)] backdrop-blur-md dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.97,hsl(var(--surface-1))/0.95)]"
        data-testid="git-pr-popover"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground/90">{branch ?? '无分支'}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {suggestion ? `基准分支: ${suggestion.base}` : '基于分支提交记录生成 PR 标题与描述'}
            </div>
          </div>
        </div>

        <input
          aria-label="PR 标题"
          data-testid="git-pr-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="PR 标题"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <textarea
          ref={textareaRef}
          aria-label="PR 描述"
          data-testid="git-pr-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="PR 描述（Markdown）"
          rows={5}
          className="mt-2 max-h-70 min-h-32 w-full resize-none overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="git-pr-generate"
            onClick={onGenerate}
            disabled={generating}
            className="flex-1"
          >
            <Bot className="mr-1.5 h-3.5 w-3.5" />
            {suggestion ? '重新生成' : 'AI 生成'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="复制 PR 标题与描述"
            data-testid="git-pr-copy"
            onClick={() => void copySuggestion()}
            disabled={!title.trim() && !body.trim()}
            className="shrink-0"
          >
            {copied ? (
              <>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                已复制
              </>
            ) : (
              <>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                复制
              </>
            )}
          </Button>
        </div>

        {error && (
          <p className={cn('mt-2 text-xs text-destructive')}>{error}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
