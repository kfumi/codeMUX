import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, Copy } from 'lucide-react';

import type { CreatePullRequestResult, GitBranch, GitPullRequestSuggestion } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

interface GitPullRequestPopoverProps {
  trigger: ReactNode;
  branch: string | null;
  branches: GitBranch[];
  base: string;
  suggestion: GitPullRequestSuggestion | null;
  generating: boolean;
  creating: boolean;
  error: string | null;
  createError: string | null;
  result: CreatePullRequestResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerate: () => void;
  onBaseChange: (base: string) => void;
  onCreate: (request: { title: string; body: string; base: string }) => void;
}

export function GitPullRequestPopover({
  trigger,
  branch,
  branches,
  base,
  suggestion,
  generating,
  creating,
  error,
  createError,
  result,
  open,
  onOpenChange,
  onGenerate,
  onBaseChange,
  onCreate,
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
        className="w-105 max-w-[calc(100vw-24px)] rounded-lg border border-border/70 bg-popover/98 p-3 shadow-[0_22px_58px_-34px_hsl(var(--surface-shadow-strong)/0.42),0_0_0_1px_hsl(var(--background)/0.7)] backdrop-blur-md dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.97,hsl(var(--surface-1))/0.95)]"
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

        <Select value={base} onValueChange={onBaseChange}>
          <SelectTrigger aria-label="PR 基准分支" className="h-8 rounded-lg px-3 text-xs">
            <SelectValue placeholder="选择目标分支" />
          </SelectTrigger>
          <SelectContent>
            {branches
              .filter((candidate) => candidate.name !== branch)
              .map((candidate) => (
                <SelectItem key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <input
          aria-label="PR 标题"
          data-testid="git-pr-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="PR 标题"
          className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            disabled={generating || creating}
            className="flex-1"
          >
            <Bot className="mr-1.5 h-3.5 w-3.5" />
            {generating ? '生成中...' : suggestion ? '重新生成' : 'AI 生成'}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="git-pr-create"
            onClick={() => onCreate({ title, body, base })}
            disabled={creating || generating || !base}
            className="shrink-0"
          >
            {creating ? '创建中...' : '创建 PR'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="复制 PR 标题与描述"
            data-testid="git-pr-copy"
            onClick={() => void copySuggestion()}
            disabled={creating || (!title.trim() && !body.trim())}
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
        {createError && <p className="mt-2 text-xs text-destructive">{createError}</p>}
        {result && (
          <p className="mt-2 text-xs text-[hsl(var(--success))]">
            已创建 {result.platform} PR #{result.number}：
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="ml-1 underline underline-offset-2"
            >
              打开 PR
            </a>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
