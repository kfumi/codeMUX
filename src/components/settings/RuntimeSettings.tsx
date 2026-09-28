import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopBridge } from '@/lib/desktop-bridge';
import {
  CheckCircle2,
  ChevronDown,
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

import { useHostCapabilities } from '@/hooks/useHostCapabilities';
import { shellFacade } from '@/lib/facades/shell-facade';
import type {
  AgentRuntimeCheck,
  AgentRuntimeCheckResult,
  AgentRuntimeStatus,
} from '@/lib/desktop-bridge';
import type {
  ManagedNodeInfo,
  ManagedRuntimeCheckResult,
  ManagedRuntimeInfo,
  ManagedRuntimeOperationResult,
  ManagedRuntimeStatus,
  RuntimeInstallProgress,
  RuntimeInstallProgressEvent,
  RuntimeProvider,
} from '@/lib/runtimeTypes';
import { daemonFacade } from '@/lib/facades/daemon-facade';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
  pi: 'text-fuchsia-500',
};

const CLI_STATUS_LABEL: Record<AgentRuntimeStatus, string> = {
  ok: '正常',
  outdated: '可升级',
  missing: '未安装',
  error: '异常',
};

const STAGE_LABEL: Record<RuntimeInstallProgress['stage'], string> = {
  resolving: '解析版本',
  downloading: '执行 npm 安装',
  verifying_integrity: '校验完整性',
  switching: '切换版本',
  cleaning: '清理旧版本',
  done: '完成',
  failed: '失败',
};

export function formatCheckedAt(value: string): string {
  const numericValue = Number(value);
  const date = Number.isFinite(numericValue) && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? new Date(numericValue * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/i, '')
      .split(/[+-]/, 1)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

function isStableVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

type OperationKind = 'install' | 'upgrade' | 'repair' | 'remove';

interface ProviderOperationState {
  kind: OperationKind;
  progress: RuntimeInstallProgress | null;
  /** 操作开始的墙上时间，供进度条显示已用时；daemon 不上报耗时。 */
  startedAt: number;
}

export function RuntimeSettingsPanel({
  onOpenSystemTools,
}: {
  onOpenSystemTools?: () => void;
}) {
  // 外部 CLI 诊断探测的是壳进程所在机器的 PATH(host.agent-cli):浏览器/移动
  // 形态隐藏该区块,托管 Runtime 走 daemon 协议,三形态一致保留。
  const capabilities = useHostCapabilities();
  const canCheckHostCli = capabilities.has('host.agent-cli');
  const [checkResult, setCheckResult] = useState<ManagedRuntimeCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [operations, setOperations] = useState<Record<string, ProviderOperationState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [versionLoading, setVersionLoading] = useState<Record<string, boolean>>({});
  const [versionErrors, setVersionErrors] = useState<Record<string, string>>({});
  const versionLoadId = useRef(0);

  const loadVersionLists = useCallback(async (providers: RuntimeProvider[]) => {
    const requestId = versionLoadId.current + 1;
    versionLoadId.current = requestId;
    setVersionLoading(() => Object.fromEntries(providers.map((provider) => [provider, true])));
    setVersionErrors((prev) => {
      const next = { ...prev };
      providers.forEach((provider) => delete next[provider]);
      return next;
    });

    await Promise.all(
      providers.map(async (provider) => {
        try {
          const versions = (await daemonFacade.managedRuntime.listVersions(provider)).filter(isStableVersion);
          if (versionLoadId.current !== requestId) return;
          setCheckResult((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              runtimes: prev.runtimes.map((runtime) => {
                if (runtime.provider !== provider) return runtime;
                const latest = versions[0];
                const isOutdated =
                  runtime.status !== 'corrupted' &&
                  runtime.currentVersion !== null &&
                  latest !== undefined &&
                  compareVersions(latest, runtime.currentVersion) > 0;
                const status: ManagedRuntimeStatus =
                  runtime.status === 'corrupted' || runtime.status === 'node_unavailable'
                    ? runtime.status
                    : runtime.currentVersion === null
                      ? 'missing'
                      : isOutdated
                        ? 'outdated'
                        : 'ready';
                return {
                  ...runtime,
                  availableVersions: versions,
                  status,
                  message:
                    status === 'outdated' && latest
                      ? `${runtime.label} ${runtime.currentVersion} 可更新到 ${latest}`
                      : runtime.message,
                };
              }),
            };
          });
        } catch (error) {
          if (versionLoadId.current !== requestId) return;
          setVersionErrors((prev) => ({
            ...prev,
            [provider]: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          if (versionLoadId.current !== requestId) return;
          setVersionLoading((prev) => ({ ...prev, [provider]: false }));
        }
      }),
    );
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    try {
      const result = await daemonFacade.checkManagedRuntimes();
      setCheckResult(result);
      if (canInstallManagedRuntime(result.node)) {
        void loadVersionLists(result.runtimes.map((runtime) => runtime.provider));
      }
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [loadVersionLists]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  // 监听所有 Provider 的安装进度事件(daemon 桌面 UI 事件出口,同名同形)
  useEffect(() => {
    const handleProgress = (payload: unknown) => {
      const { provider, progress } = (payload ?? {}) as RuntimeInstallProgressEvent;
      setOperations((prev) => ({
        ...prev,
        [provider]: {
          kind: prev[provider]?.kind ?? 'install',
          progress,
          // 进度事件可能先于本地操作状态到达，兜一个当前时间，之后保持不变。
          startedAt: prev[provider]?.startedAt ?? Date.now(),
        },
      }));
    };
    const unsubscribe = desktopBridge?.onDesktopEvent('runtime-install-progress', handleProgress);
    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    const toastId = toast.loading('正在检测 Runtime...');
    try {
      const result = await daemonFacade.checkManagedRuntimes();
      setCheckResult(result);
      if (canInstallManagedRuntime(result.node)) {
        void loadVersionLists(result.runtimes.map((runtime) => runtime.provider));
      }
      toast.success('Runtime 检测已更新', { id: toastId });
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`, { id: toastId });
    } finally {
      setLoading(false);
    }
  }, [loadVersionLists]);

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
        [provider]: { kind, progress: null, startedAt: Date.now() },
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
        const refreshed = await daemonFacade.checkManagedRuntimes();
        setCheckResult(refreshed);
        if (canInstallManagedRuntime(refreshed.node)) {
          void loadVersionLists(refreshed.runtimes.map((runtime) => runtime.provider));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrors((prev) => ({ ...prev, [provider]: message }));
        toast.error(`${label}${describeOperation(kind)}失败：${message}`, { id: toastId });
      } finally {
        clearOperation(provider);
      }
    },
    [clearOperation, loadVersionLists],
  );

  const handleInstall = useCallback(
    (provider: RuntimeProvider, label: string, version?: string) =>
      runOperation(provider, label, 'install', () => daemonFacade.managedRuntime.install(provider, version)),
    [runOperation],
  );

  const handleRepair = useCallback(
    (provider: RuntimeProvider, label: string) =>
      runOperation(provider, label, 'repair', () => daemonFacade.managedRuntime.repair(provider)),
    [runOperation],
  );

  const handleRemove = useCallback(
    async (provider: RuntimeProvider, label: string) => {
      setOperations((prev) => ({
        ...prev,
        [provider]: { kind: 'remove', progress: null, startedAt: Date.now() },
      }));
      const toastId = toast.loading(`正在删除 ${label}...`);
      try {
        await daemonFacade.managedRuntime.remove(provider);
        toast.success(`${label} 已删除`, { id: toastId });
        const refreshed = await daemonFacade.checkManagedRuntimes();
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

      {checkResult && <NodeStatusCard node={checkResult.node} onOpenSystemTools={onOpenSystemTools} />}

      <div className="space-y-3">
        {loading && !checkResult ? (
          <div className="rounded-lg border border-border/50 p-4 text-ui-compact text-muted-foreground">
            正在检测 Runtime...
          </div>
        ) : (
          checkResult?.runtimes.map((runtime) => (
            <ProviderRuntimeCard
              key={runtime.provider}
              runtime={runtime}
              operation={operations[runtime.provider]}
              errorMessage={errors[runtime.provider]}
              versionLoading={versionLoading[runtime.provider] === true}
              versionError={versionErrors[runtime.provider]}
              onInstall={(version) => handleInstall(runtime.provider, runtime.label, version)}
              onRepair={() => handleRepair(runtime.provider, runtime.label)}
              onRemove={() => handleRemove(runtime.provider, runtime.label)}
            />
          ))
        )}
      </div>

      {checkResult?.checkedAt && (
        <p className="text-ui-caption text-muted-foreground">检测时间：{formatCheckedAt(checkResult.checkedAt)}</p>
      )}

      {canCheckHostCli && <ExternalCliSection />}
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

function canInstallManagedRuntime(node: ManagedNodeInfo): boolean {
  return node.satisfiesMinimum && node.npm.available && node.npm.matchesNode;
}

/* ------------------------------- Node 状态区 ------------------------------- */

function NodeStatusCard({
  node,
  onOpenSystemTools,
}: {
  node: ManagedNodeInfo;
  onOpenSystemTools?: () => void;
}) {
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
        <Terminal className={cn('h-4 w-4 shrink-0', ok ? 'text-muted-foreground' : 'text-red-500')} />
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
          <span className="shrink-0 text-muted-foreground">版本</span>
          <span className="truncate font-mono text-foreground">
            {node.version ?? (node.available ? '未知' : '未检测到')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">路径</span>
          <span className="truncate font-mono text-foreground">{node.executablePath ?? '-'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">npm</span>
          <span className={cn('truncate font-mono', node.npm.available && node.npm.matchesNode ? 'text-foreground' : 'text-red-600 dark:text-red-400')}>
            {node.npm.version ?? (node.npm.available ? '未知' : '未检测到')}
          </span>
        </div>
      </div>
      {onOpenSystemTools && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 h-7 gap-1.5 px-0 text-ui-caption text-muted-foreground hover:text-foreground"
          onClick={onOpenSystemTools}
        >
          <Terminal className="h-3.5 w-3.5" />
          在系统工具中查看 Node.js 与 npm
        </Button>
      )}
      {!ok && (
        <p className="mt-2 text-ui-caption text-red-600 dark:text-red-400">
          {node.error ?? 'Node.js 不可用或版本低于 18，请安装 Node 18+ 后重试。'}
        </p>
      )}
      {ok && (!node.npm.available || !node.npm.matchesNode) && (
        <p className="mt-2 text-ui-caption text-amber-600 dark:text-amber-300">
          {node.npm.error ?? 'npm 不可用，Runtime 安装可能失败。'}
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
  versionLoading: boolean;
  versionError: string | undefined;
  onInstall: (version?: string) => void;
  onRepair: () => void;
  onRemove: () => void;
}

function ProviderRuntimeCard({
  runtime,
  operation,
  errorMessage,
  versionLoading,
  versionError,
  onInstall,
  onRepair,
  onRemove,
}: ProviderRuntimeCardProps) {
  const dotColor = PROVIDER_DOT_COLOR[runtime.provider] ?? 'text-muted-foreground';
  const isOperating = operation !== undefined;
  const progress = operation?.progress ?? null;
  const effectiveStatus: ManagedRuntimeStatus = isOperating ? 'installing' : runtime.status;
  const meta = RUNTIME_STATUS_META[effectiveStatus];
  const StatusIcon = meta.icon;
  const [selectedVersion, setSelectedVersion] = useState('');

  useEffect(() => {
    setSelectedVersion((previous) =>
      previous && runtime.availableVersions.includes(previous)
        ? previous
        : runtime.availableVersions[0] ?? runtime.currentVersion ?? '',
    );
  }, [runtime.availableVersions, runtime.currentVersion, selectedVersion]);

  const showRepair = runtime.status === 'corrupted' && !isOperating;
  const hasSelectedVersion = Boolean(selectedVersion);
  const selectedIsCurrent = hasSelectedVersion && selectedVersion === runtime.currentVersion;
  const showVersionAction = !isOperating && !versionLoading && hasSelectedVersion;
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
              <span className="shrink-0 text-muted-foreground">版本</span>
              <span className="truncate font-mono text-foreground">
                {runtime.currentVersion ?? '-'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-muted-foreground">路径</span>
              <span className="truncate font-mono text-foreground">
                {runtime.installPath ?? '-'}
              </span>
            </div>
          </div>

          {(versionLoading || runtime.availableVersions.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="shrink-0 text-ui-caption text-muted-foreground">目标版本</span>
              <Select
                value={selectedVersion || undefined}
                onValueChange={setSelectedVersion}
                disabled={isOperating || versionLoading}
              >
                <SelectTrigger className="h-8 w-56 text-ui-compact">
                  <SelectValue placeholder="选择 SDK 版本" />
                </SelectTrigger>
                <SelectContent>
                  {runtime.availableVersions.map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}{version === runtime.currentVersion ? '（当前）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {versionLoading && (
            <div className="flex items-center gap-2 rounded-md border border-blue-500/25 bg-blue-500/5 px-3 py-2 text-ui-caption text-blue-600 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              版本列表加载中
            </div>
          )}

          {versionError && !versionLoading && (
            <p className="text-ui-caption leading-5 text-amber-600 dark:text-amber-300">
              暂时无法加载 npm 版本列表：{versionError}
            </p>
          )}

          {progress && (
            <ProgressBar progress={progress} startedAt={operation?.startedAt ?? Date.now()} />
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
          {showVersionAction && (
            <Button
              variant={selectedIsCurrent ? 'outline' : 'default'}
              size="sm"
              className="gap-1.5"
              disabled={selectedIsCurrent}
              onClick={() => onInstall(selectedVersion)}
            >
              {selectedIsCurrent ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : runtime.currentVersion ? (
                <RefreshCw className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {selectedIsCurrent
                ? '当前版本'
                : runtime.currentVersion
                  ? `更新到 ${selectedVersion}`
                  : `安装 ${selectedVersion}`}
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
            <Button variant="default" size="sm" className="gap-1.5" onClick={() => onInstall(selectedVersion || undefined)}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试安装
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
          <div className="mb-1.5 text-ui-caption text-muted-foreground">已安装版本</div>
          <div className="flex flex-wrap gap-1.5">
            {runtime.installedVersions.map((version) => (
              <span
                key={version}
                className="rounded-md bg-muted/50 px-2 py-0.5 font-mono text-ui-caption text-foreground"
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

/**
 * daemon 的进度字段是 Rust `Option`，"未知"时字段直接不出现；旧版本 daemon 会发
 * `null`。两种都要归一成 `null`（未知），绝不能落到 `?? 0` ——那会把"没有数据"
 * 画成一个假的 0%。
 */
export function knownNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 超过一分钟用「x分y秒」，否则只报秒 —— 安装动辄一两分钟，秒数更有存在感。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}

export function ProgressBar({
  progress,
  startedAt,
}: {
  progress: RuntimeInstallProgress;
  startedAt: number;
}) {
  const percent = knownNumber(progress.percent);
  const bytesDone = knownNumber(progress.bytesDone);
  const bytesTotal = knownNumber(progress.bytesTotal);
  const elapsed = useElapsedSeconds(startedAt);
  const stageLabel = STAGE_LABEL[progress.stage] ?? progress.stage;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-ui-caption text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span className="truncate">
            {stageLabel}
            {progress.message ? ` · ${progress.message}` : ''}
          </span>
        </span>
        {/* 百分比是 daemon 真的测出来才显示；未知时宁可留空也不编一个 0%。 */}
        {percent !== null && (
          <span className="shrink-0 font-mono text-muted-foreground">{percent}%</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        {percent === null ? (
          // 不确定态：npm 没有可用的百分比接口，与其画一条永远停在低位的假进度条，
          // 不如明确告诉用户「还在动」——下方的时间与步骤数就是真实证据。
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-all duration-slow"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between text-ui-caption text-muted-foreground">
        <span className="font-mono">{bytesDone !== null && bytesTotal !== null
          ? `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`
          : ''}</span>
        <span className="font-mono">已用时 {formatElapsed(elapsed)}</span>
      </div>
    </div>
  );
}

/** 每秒推进一次的已用时秒数，让长时间没有新事件的安装也不会显得卡死。 */
function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return now - startedAt;
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
  const [open, setOpen] = useState(false);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      const res = await shellFacade.checkAgentRuntimes();
      setResult(res);
    } catch (err) {
      toast.error(`检测失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <section className="border-t border-border/40 pt-6">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 rounded-lg px-1 py-1 text-left hover:bg-muted/25"
          >
            <span className="space-y-1">
              <span className="block text-ui-heading-sm font-semibold text-foreground">外部 CLI 诊断</span>
              <span className="block text-ui-compact leading-relaxed text-muted-foreground">
                只读查看系统 PATH 中的 CLI，与 CodeMUX 托管 Runtime 独立。
              </span>
            </span>
            <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-4">
          <p className="text-ui-caption text-muted-foreground">
            外部 CLI 未安装或版本异常，不影响 CodeMUX 使用已安装的托管 Runtime。
          </p>
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
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ExternalCliRow({ check }: { check: AgentRuntimeCheck }) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-ui-compact font-medium text-foreground">{check.label}</span>
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-ui-caption text-muted-foreground">
            {check.command}
          </code>
        </div>
        <span className="shrink-0 text-ui-caption text-muted-foreground">
          {CLI_STATUS_LABEL[check.status]}
        </span>
      </div>
      <div className="mt-2 grid gap-1.5 text-ui-caption sm:grid-cols-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">版本</span>
          <span className="truncate font-mono text-foreground">{check.currentVersion ?? '-'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">路径</span>
          <span className="truncate font-mono text-foreground">{check.executablePath ?? '-'}</span>
        </div>
      </div>
    </div>
  );
}
