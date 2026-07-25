import { useCallback, type HTMLAttributes } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

import type { AgentInstallation, InstallSource } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// shadcn/ui Badge 在本项目尚未单独抽取，此处复用其标准 API 与样式约定，便于后续替换。
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const BADGE_VARIANT_CLASS: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
  secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
  outline: 'text-foreground border-border',
};

function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
        BADGE_VARIANT_CLASS[variant],
        className,
      )}
      {...props}
    />
  );
}

const SOURCE_LABELS: Record<InstallSource, string> = {
  nvm: 'nvm',
  homebrew: 'brew',
  volta: 'volta',
  fnm: 'fnm',
  mise: 'mise',
  bun: 'bun',
  pnpm: 'pnpm',
  scoop: 'scoop',
  system: 'system',
  unknown: 'unknown',
};

interface AgentInstallRowProps {
  install: AgentInstallation;
}

export function AgentInstallRow({ install }: AgentInstallRowProps) {
  const { source, path, version, runnable, isPathDefault } = install;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  }, [path]);

  return (
    <div className="flex items-center gap-2 rounded py-1.5 transition-colors hover:bg-muted/50">
      <Badge variant="secondary" className="w-16 shrink-0 justify-center">
        {SOURCE_LABELS[source]}
      </Badge>

      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span
          className="truncate font-mono text-xs text-muted-foreground"
          title={path}
        >
          {path}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground/60 hover:text-foreground"
          onClick={handleCopy}
          aria-label="复制路径"
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>

      <div className="shrink-0 text-xs">
        {runnable ? (
          version ? (
            <span className="font-mono text-foreground/80">{version}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        ) : (
          <span className="text-destructive">无法运行</span>
        )}
      </div>

      {isPathDefault && (
        <Badge variant="outline" className="shrink-0">
          默认
        </Badge>
      )}
    </div>
  );
}
