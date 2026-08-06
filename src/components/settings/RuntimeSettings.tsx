import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  CheckCircle2,
  CircleDot,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wrench,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  appApi,
  type AgentRuntimeCheck,
  type AgentRuntimeCheckResult,
  type AgentRuntimeStatus,
  type ManagedNodeInfo,
  type ManagedRuntimeCheckResult,
  type ManagedRuntimeInfo,
  type ManagedRuntimeOperationResult,
  type ManagedRuntimeStatus,
  type RuntimeInstallProgress,
  type RuntimeInstallProgressEvent,
  type RuntimeProvider,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export const RUNTIME_STATUS_META: Record<
  ManagedRuntimeStatus,
  { label: string; className: string; icon: LucideIcon }
> = {
  ready: {
    label: '已就绪',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    icon: CheckCircle2,
  },
  missing: {
    label: '未安装',
    className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    icon: CircleDot,
  },
  outdated: {
    label: '可升级',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    icon: TriangleAlert,
  },
  corrupted: {
    label: '已损坏',
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    icon: TriangleAlert,
  },
  node_unavailable: {
    label: 'Node 不可用',
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    icon: TriangleAlert,
  },
  error: {
    label: '异常',
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    icon: TriangleAlert,
  },
  installing: {
    label: '安装中',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    icon: Loader2,
  },
};

const PROVIDER_DOT_COLOR: Record<RuntimeProvider, string> = {
  claude_code: 'text-orange-500',
  codex: 'text-emerald-500',
  opencode: 'text-blue-500',
};

const CLI_STATUS_LABEL: Record<AgentRuntimeStatus, string> = {
  ok: '正常',
  outdated: '可升级',
  missing: '未安装',
  error: '异常',
};

const STAGE_LABEL: Record<RuntimeInstallProgress['stage'], string> = {
  resolving: '解析版本',
  downloading: '下载 Runtime',
  verifying_signature: '校验签名',
  verifying_hash: '校验哈希',
  extracting: '解压安装',
  verifying_integrity: '校验完整性',
  switching: '切换版本',
  cleaning: '清理旧版本',
  done: '完成',
  failed: '失败',
};

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

type OperationKind = 'install' | 'upgrade' | 'repair' | 'remove';

interface ProviderOperationState {
  kind: OperationKind;
  progress: RuntimeInstallProgress | null;
}

export function RuntimeSettingsPanel() {
  const [checkResult, setCheckResult] = useState<ManagedRuntimeCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [operations, setOperations] = useState<Record<string, ProviderOperationState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const runCheck = useCallback(async () => {
    setLoading(true);
    try {
      const result = await appApi.checkManagedRuntimes();
      setCheckResult(result);
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  // 监听所有 Provider 的安装进度事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<RuntimeInstallProgressEvent>('runtime-install-progress', (event) => {
      const { provider, progress } = event.payload;
      setOperations((prev) => ({
        ...prev,
        [provider]: { kind: prev[provider]?.kind ?? 'install', progress },
      }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    const toastId = toast.loading('正在检测 Runtime...');
    try {
      const result = await appApi.checkManagedRuntimes();
      setCheckResult(result);
      toast.success('Runtime 检测已更新', { id: toastId });
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`, { id: toastId });
    } finally {
      setLoading(false);
    }
  }, []);

  const clearOperation = useCallback((provider: string) => {
    setOperations((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  }, []);

  const runOperation = useCallback(
    async (
      provider: RuntimeProvider,
      label: string,
      kind: OperationKind,
      executor: () => Promise<ManagedRuntimeOperationResult | null>,
    ) => {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setOperations((prev) => ({
        ...prev,
        [provider]: { kind, progress: null },
      }));
      const toastId = toast.loading(`正在${describeOperation(kind)} ${label}...`);
      try {
        const result = await executor();
        if (result) {
          toast.success(
            `${label} 已${describeOperation(kind)}到 ${result.installedVersion}`,
            { id: toastId },
          );
        } else {
          toast.success(`${label} 无需${describeOperation(kind)}`, { id: toastId });
        }
        // 操作完成后刷新整体状态
        const refreshed = await appApi.checkManagedRuntimes();
        setCheckResult(refreshed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrors((prev) => ({ ...prev, [provider]: message }));
        toast.error(`${label}${describeOperation(kind)}失败：${message}`, { id: toastId });
      } finally {
        clearOperation(provider);
      }
    },
    [clearOperation],
  );

  const handleInstall = useCallback(
    (provider: RuntimeProvider, label: string) =>
      runOperation(provider, label, 'install', () => appApi.installManagedRuntime(provider)),
    [runOperation],
  );

  const handleUpgrade = useCallback(
    (provider: RuntimeProvider, label: string) =>
      runOperation(provider, label, 'upgrade', () => appApi.upgradeManagedRuntime(provider)),
    [runOperation],
  );

  const handleRepair = useCallback(
    (provider: RuntimeProvider, label: string) =>
      runOperation(provider, label, 'repair', () => appApi.repairManagedRuntime(provider)),
    [runOperation],
  );

  const handleRemove = useCallback(
    async (provider: RuntimeProvider, label: string) => {
      setOperations((prev) => ({
        ...prev,
        [provider]: { kind: 'remove', progress: null },
      }));
      const toastId = toast.loading(`正在删除 ${label}...`);
      try {
        await appApi.removeManagedRuntime(provider);
        toast.success(`${label} 已删除`, { id: toastId });
        const refreshed = await appApi.checkManagedRuntimes();
        setCheckResult(refreshed);
      } catch (err) {
        toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`, { id: toastId });
      } finally {
        clearOperation(provider);
      }
    },
    [clearOperation],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-ui-heading-sm font-semibold text-foreground">托管 Runtime</h3>
          <p className="text-ui-compact leading-relaxed text-muted-foreground">
            CodeMUX 自管理的 SDK Runtime，与全局 CLI 解耦，可独立安装、校验与回滚。
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={handleRefresh} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新检测
        </Button>
      </div>

      {checkResult && <NodeStatusCard node={checkResult.node} />}

      <div className="space-y-3">
        {loading && !checkResult ? (
          <div className="rounded-lg border border-border/50 p-4 text-ui-compact text-foreground/60">
            正在检测 Runtime...
          </div>
        ) : (
          checkResult?.runtimes.map((runtime) => (
            <ProviderRuntimeCard
              key={runtime.provider}
              runtime={runtime}
              operation={operations[runtime.provider]}
              errorMessage={errors[runtime.provider]}
              onInstall={() => handleInstall(runtime.provider, runtime.label)}
              onUpgrade={() => handleUpgrade(runtime.provider, runtime.label)}
              onRepair={() => handleRepair(runtime.provider, runtime.label)}
              onRemove={() => handleRemove(runtime.provider, runtime.label)}
            />
          ))
        )}
      </div>

      {checkResult?.checkedAt && (
        <p className="text-ui-caption text-foreground/45">检测时间：{formatCheckedAt(checkResult.checkedAt)}</p>
      )}

      <ExternalCliSection />
    </div>
  );
}

function describeOperation(kind: OperationKind): string {
  switch (kind) {
    case 'install':
      return '安装';
    case 'upgrade':
      return '升级';
    case 'repair':
      return '修复';
    case 'remove':
      return '删除';
  }
}

/* ------------------------------- Node 状态区 ------------------------------- */

function NodeStatusCard({ node }: { node: ManagedNodeInfo }) {
  const ok = node.available && node.satisfiesMinimum;
  const Icon = ok ? CheckCircle2 : TriangleAlert;

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        ok ? 'border-border/50' : 'border-red-500/30 bg-red-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        <Terminal className={cn('h-4 w-4 shrink-0', ok ? 'text-foreground/50' : 'text-red-500')} />
        <h4 className="text-ui-body font-semibold text-foreground">Node.js</h4>
        <Icon className={cn('ml-auto h-4 w-4 shrink-0', ok ? 'text-emerald-500' : 'text-red-500')} />
        {!ok && (
          <span className="text-ui-caption font-medium text-red-600 dark:text-red-400">
            需安装 Node 18+
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-2 text-ui-compact sm:grid-cols-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-foreground/45">版本</span>
          <span className="truncate font-mono text-foreground/80">
            {node.version ?? (node.available ? '未知' : '未检测到')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-foreground/45">路径</span>
          <span className="truncate font-mono text-foreground/80">{node.executablePath ?? '-'}</span>
        </div>
      </div>
      {!ok && (
        <p className="mt-2 text-ui-caption text-red-600 dark:text-red-400">
          {node.error ?? 'Node.js 不可用或版本低于 18，请安装 Node 18+ 后重试。'}
        </p>
      )}
    </div>
  );
}

/* --------------------------- Provider Runtime 卡片 --------------------------- */

interface ProviderRuntimeCardProps {
  runtime: ManagedRuntimeInfo;
  operation: ProviderOperationState | undefined;
  errorMessage: string | undefined;
  onInstall: () => void;
  onUpgrade: () => void;
  onRepair: () => void;
  onRemove: () => void;
}

function ProviderRuntimeCard({
  runtime,
  operation,
  errorMessage,
  onInstall,
  onUpgrade,
  onRepair,
  onRemove,
}: ProviderRuntimeCardProps) {
  const dotColor = PROVIDER_DOT_COLOR[runtime.provider] ?? 'text-foreground/50';
  const isOperating = operation !== undefined;
  const progress = operation?.progress ?? null;
  const effectiveStatus: ManagedRuntimeStatus = isOperating ? 'installing' : runtime.status;
  const meta = RUNTIME_STATUS_META[effectiveStatus];
  const StatusIcon = meta.icon;

  const showInstall = runtime.status === 'missing' && !isOperating;
  const showUpgrade = runtime.status === 'outdated' && !isOperating;
  const showRepair = runtime.status === 'corrupted' && !isOperating;
  const showRemove =
    (runtime.status === 'ready' ||
      runtime.status === 'outdated' ||
      runtime.status === 'corrupted') &&
    !isOperating;

  const retryKind = operation?.kind;
  const showRetry = errorMessage !== undefined && retryKind !== undefined && retryKind !== 'remove';

  return (
    <div className="rounded-lg border border-border/50 p-4">
      <div className="flex items-start gap-4">
        <CircleDot className={cn('mt-0.5 h-5 w-5 shrink-0', dotColor)} />

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-ui-body font-semibold text-foreground">{runtime.label}</h4>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-ui-caption font-medium',
                meta.className,
              )}
            >
              <StatusIcon className={cn('h-3 w-3', effectiveStatus === 'installing' && 'animate-spin')} />
              {meta.label}
            </span>
          </div>

          <div className="space-y-1 text-ui-compact">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-foreground/45">版本</span>
              <span className="truncate font-mono text-foreground/80">
                {runtime.currentVersion ?? '-'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-foreground/45">路径</span>
              <span className="truncate font-mono text-foreground/80">
                {runtime.installPath ?? '-'}
              </span>
            </div>
          </div>

          {progress && (
            <ProgressBar progress={progress} />
          )}

          {errorMessage && (
            <p className="text-ui-caption leading-5 text-red-600 dark:text-red-400">
              {errorMessage}
            </p>
          )}

          {!errorMessage && runtime.message && !isOperating && (
            <p className="text-ui-caption leading-5 text-muted-foreground">{runtime.message}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {showInstall && (
            <Button variant="default" size="sm" className="gap-1.5" onClick={onInstall}>
              <Download className="h-3.5 w-3.5" />
              安装
            </Button>
          )}
          {showUpgrade && (
            <Button variant="default" size="sm" className="gap-1.5" onClick={onUpgrade}>
              <RefreshCw className="h-3.5 w-3.5" />
              更新
            </Button>
          )}
          {showRepair && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRepair}>
              <Wrench className="h-3.5 w-3.5" />
              修复
            </Button>
          )}
          {showRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
          )}
          {showRetry && retryKind === 'install' && (
            <Button variant="default" size="sm" className="gap-1.5" onClick={onInstall}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试安装
            </Button>
          )}
          {showRetry && retryKind === 'upgrade' && (
            <Button variant="default" size="sm" className="gap-1.5" onClick={onUpgrade}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试更新
            </Button>
          )}
          {showRetry && retryKind === 'repair' && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRepair}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试修复
            </Button>
          )}
          {isOperating && (
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {describeOperation(operation!.kind)}中
            </Button>
          )}
        </div>
      </div>

      {runtime.installedVersions.length > 1 && (
        <div className="mt-3 border-t border-border/40 pt-3">
          <div className="mb-1.5 text-ui-caption text-foreground/45">已安装版本</div>
          <div className="flex flex-wrap gap-1.5">
            {runtime.installedVersions.map((version) => (
              <span
                key={version}
                className="rounded-md bg-muted/50 px-2 py-0.5 font-mono text-ui-caption text-foreground/70"
              >
                {version}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- 进度条 ------------------------------- */

function ProgressBar({ progress }: { progress: RuntimeInstallProgress }) {
  const percent = progress.percent ?? 0;
  const stageLabel = STAGE_LABEL[progress.stage] ?? progress.stage;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-ui-caption text-foreground/60">
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {stageLabel}
          {progress.message ? ` · ${progress.message}` : ''}
        </span>
        {progress.percent !== undefined && (
          <span className="font-mono text-foreground/55">{percent}%</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      {progress.bytesTotal !== undefined && progress.bytesDone !== undefined && (
        <div className="text-ui-caption text-foreground/45">
          {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ----------------------------- 外部 CLI 诊断区 ----------------------------- */

function ExternalCliSection() {
  const [result, setResult] = useState<AgentRuntimeCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      const res = await appApi.checkAgentRuntimes();
      setResult(res);
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <section className="space-y-4 border-t border-border/40 pt-6">
      <div className="space-y-1">
        <h3 className="text-ui-heading-sm font-semibold text-foreground">外部 CLI 环境</h3>
        <p className="text-ui-compact leading-relaxed text-muted-foreground">
          以下为 PATH 中的全局 CLI 诊断，与 CodeMUX 自有 Runtime 独立。外部 CLI 未安装不影响 CodeMUX 会话。
        </p>
      </div>

      <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCheck} disabled={checking}>
        {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />}
        检测外部 CLI
      </Button>

      {result && (
        <div className="space-y-2">
          {result.runtimes.map((check) => (
            <ExternalCliRow key={check.agentKind} check={check} />
          ))}
        </div>
      )}
    </section>
  );
}

function ExternalCliRow({ check }: { check: AgentRuntimeCheck }) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
          <span className="shrink-0 text-ui-compact font-medium text-foreground">{check.label}</span>
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-ui-caption text-foreground/60">
            {check.command}
          </code>
        </div>
        <span className="shrink-0 text-ui-caption text-foreground/55">
          {CLI_STATUS_LABEL[check.status]}
        </span>
      </div>
      <div className="mt-2 grid gap-1.5 text-ui-caption sm:grid-cols-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-foreground/45">版本</span>
          <span className="truncate font-mono text-foreground/75">{check.currentVersion ?? '-'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-foreground/45">路径</span>
          <span className="truncate font-mono text-foreground/75">{check.executablePath ?? '-'}</span>
        </div>
      </div>
    </div>
  );
}
