import { Bot, GitCommitHorizontal } from 'lucide-react';

import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

interface GitCommitBoxProps {
  message: string;
  stagedCount: number;
  loading: boolean;
  generating: boolean;
  committing: boolean;
  error: string | null;
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onCommit: () => void;
}

export function GitCommitBox({
  message,
  stagedCount,
  loading,
  generating,
  committing,
  error,
  onMessageChange,
  onGenerate,
  onCommit,
}: GitCommitBoxProps) {
  const disabled = loading || stagedCount === 0;

  return (
    <div className="shrink-0 border-t border-border/25 px-4 py-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="提交信息"
          data-testid="git-commit-message"
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder={stagedCount > 0 ? 'feat: 描述本次修改' : '暂存修改后可提交'}
          disabled={disabled || committing}
          className="h-9 rounded-lg"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="AI 生成提交信息"
          data-testid="git-commit-generate"
          onClick={onGenerate}
          disabled={disabled || generating || committing}
        >
          <Bot className="mr-1.5 h-3.5 w-3.5" />
          AI
        </Button>
        <Button
          type="button"
          size="sm"
          aria-label="提交已暂存修改"
          data-testid="git-commit-submit"
          onClick={onCommit}
          disabled={disabled || committing || !message.trim()}
        >
          <GitCommitHorizontal className="mr-1.5 h-3.5 w-3.5" />
          提交
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
