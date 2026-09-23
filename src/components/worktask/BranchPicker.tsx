import { Check, ChevronDown, GitBranch, Loader2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../../lib/utils';
import type { GitBranch as GitBranchInfo } from '../../lib/gitTypes';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface BranchPickerProps {
  branches: GitBranchInfo[];
  currentBranch: string | null;
  /** 已选基线分支；空串 = 默认（项目当前分支）。 */
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  /** 禁用时的提示文案，同时作为 trigger 上的可读文本。 */
  disabledHint?: string;
  loading?: boolean;
  className?: string;
}

/**
 * 基线分支选择器：可搜索、可选当前/已有分支，也可手动输入新分支名。
 * 项目不是 Git 仓库或无项目时由父组件传入 disabled + disabledHint。
 */
export function BranchPicker({
  branches,
  currentBranch,
  value,
  onChange,
  disabled = false,
  disabledHint,
  loading = false,
  className,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const trimmedQuery = query.trim();
  const defaultLabel = currentBranch
    ? `默认：当前分支（${currentBranch}）`
    : '默认：项目当前分支';

  const filtered = useMemo(() => {
    const normalized = trimmedQuery.toLowerCase();
    if (!normalized) return branches;
    return branches.filter((branch) => branch.name.toLowerCase().includes(normalized));
  }, [branches, trimmedQuery]);

  const hasExactMatch = branches.some((branch) => branch.name === trimmedQuery);
  const canUseTypedBranch = trimmedQuery.length > 0 && !hasExactMatch;

  const select = (branch: string) => {
    onChange(branch);
    setOpen(false);
    setQuery('');
  };

  const triggerLabel = disabled ? (disabledHint ?? '不可选择') : (value || defaultLabel);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label="基线分支"
          disabled={disabled}
          className={cn(
            'h-10 w-full justify-between gap-2 px-3 text-ui-body font-normal',
            (!value || disabled) && 'text-muted-foreground',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{triggerLabel}</span>
          </span>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-60" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-56 p-2"
      >
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索或输入新分支名"
          className="mb-2 h-8 text-ui-body"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canUseTypedBranch) {
              event.preventDefault();
              select(trimmedQuery);
            }
          }}
        />
        <div className="max-h-56 overflow-y-auto">
          {canUseTypedBranch && (
            <button
              type="button"
              onClick={() => select(trimmedQuery)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui-body text-primary hover:bg-muted/70"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">使用新分支「{trimmedQuery}」</span>
            </button>
          )}

          {currentBranch && !trimmedQuery && (
            <button
              type="button"
              onClick={() => select('')}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui-body hover:bg-muted/70',
                value === '' && 'bg-muted/50',
              )}
            >
              <span className="min-w-0 flex-1 truncate">默认：当前分支（{currentBranch}）</span>
              {value === '' && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
            </button>
          )}

          {filtered.length === 0 && !canUseTypedBranch ? (
            <p className="px-2 py-3 text-ui-body text-muted-foreground">没有匹配的分支</p>
          ) : (
            filtered.map((branch) => {
              const isSelected = value === branch.name;
              return (
                <button
                  key={branch.name}
                  type="button"
                  onClick={() => select(branch.name)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui-body hover:bg-muted/70',
                    isSelected && 'bg-muted/50',
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-ui-caption text-primary">
                      当前
                    </span>
                  )}
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
