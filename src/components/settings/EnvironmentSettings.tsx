import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Terminal, TriangleAlert } from 'lucide-react';

import { appApi, type DevelopmentEnvironmentCheck, type EnvironmentCheckStatus, type EnvironmentToolCheck } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

const statusMeta: Record<EnvironmentCheckStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  ok: {
    label: '正常',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    icon: CheckCircle2,
  },
  warning: {
    label: '需升级',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    icon: TriangleAlert,
  },
  missing: {
    label: '未找到',
    className: 'border-destructive/35 bg-destructive/10 text-destructive',
    icon: AlertCircle,
  },
  error: {
    label: '异常',
    className: 'border-destructive/35 bg-destructive/10 text-destructive',
    icon: AlertCircle,
  },
};

export function EnvironmentSettings() {
  const [check, setCheck] = useState<DevelopmentEnvironmentCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await appApi.checkDevelopmentEnvironment();
      setCheck(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={runCheck} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新检测
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          环境检测失败：{error}
        </div>
      )}

      <div className="space-y-3">
        {loading && !check ? (
          <div className="rounded-xl bg-muted/40 p-5 text-sm text-foreground/60">正在检测环境...</div>
        ) : (
          check?.tools.map((tool) => <ToolCheckRow key={tool.command} tool={tool} />)
        )}
      </div>

      {check?.checkedAt && (
        <p className="text-xs text-foreground/45">检测时间：{formatCheckedAt(check.checkedAt)}</p>
      )}
    </div>
  );
}

function ToolCheckRow({ tool }: { tool: EnvironmentToolCheck }) {
  const meta = statusMeta[tool.status];
  const Icon = meta.icon;

  return (
    <div className="rounded-xl bg-muted/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-foreground/45" />
            <h4 className="text-sm font-semibold text-foreground/90">{tool.name}</h4>
            <code className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/60">{tool.command}</code>
          </div>
          <p className="mt-2 text-sm text-foreground/70">{tool.message}</p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', meta.className)}>
          <Icon className="h-3.5 w-3.5" />
          {meta.label}
        </span>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-foreground/58 sm:grid-cols-2">
        <InfoPill label="版本" value={tool.version ?? '-'} />
        <InfoPill label="路径" value={tool.path ?? '-'} />
      </div>
    </div>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/35 px-3 py-2">
      <div className="text-[11px] text-foreground/42">{label}</div>
      <div className="mt-1 truncate font-mono text-[12px] text-foreground/75">{value}</div>
    </div>
  );
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
