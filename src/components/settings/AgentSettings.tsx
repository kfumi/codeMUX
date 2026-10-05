import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Download,
  Hand,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  TriangleAlert,
  Upload,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { shellFacade } from '../../lib/facades/shell-facade';
import type {
  AgentInstallationReport,
  AgentRuntimeCheck,
  AgentRuntimeStatus,
  AgentRuntimeUpgradeResult,
} from '../../lib/desktop-bridge';
import {
  codexWorkflowModeToExecutionMode,
  mapExecutionModeToPermissionConfig,
  type AgentExecutionMode,
  type AgentPermissionConfig,
  type ClaudePermissionMode,
  type CodexWorkflowMode,
} from '../../lib/agentPermissions';
import { cn } from '../../lib/utils';
import { isProviderUsable } from '../../lib/modelProviders';
import { resolveModelDisplayName } from '../../lib/providerModels';
import {
  OPENCODE_FREE_GROUP,
  OPENCODE_FREE_PROVIDER_ID,
  useOpenCodeFreeModelOptions,
} from '../../hooks/useAgentModels';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { TooltipHint } from '../ui/tooltip';
import { useModelDisplayNames } from '../../hooks/useModelDisplayNames';
import { AgentInstallRow } from './AgentInstallRow';
import { AgentUpgradeConfirmDialog } from './AgentUpgradeConfirmDialog';

const RUNTIME_STATUS_META: Record<
  AgentRuntimeStatus,
  { label: string; className: string; icon: LucideIcon }
> = {
  ok: {
    label: '已就绪',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    icon: CheckCircle2,
  },
  outdated: {
    label: '可升级',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    icon: TriangleAlert,
  },
  missing: {
    label: '未安装',
    className: 'border-destructive/35 bg-destructive/10 text-destructive',
    icon: AlertCircle,
  },
  error: {
    label: '异常',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    icon: AlertCircle,
  },
};

// 与发送框 AgentPermissionSelector 保持一致的 Claude Code 权限选项。
const CLAUDE_PERMISSION_OPTIONS: Array<{
  mode: AgentExecutionMode;
  label: string;
  description: string;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
}> = [
  { mode: 'confirm_before_edit', label: '变更前确认', description: '修改文件或运行敏感工具前先询问。', icon: Hand },
  { mode: 'auto_edit', label: '自动编辑', description: '允许 Claude 自动编辑文件。', icon: ShieldCheck },
  { mode: 'auto_review', label: '自动模式', description: '所有操作自动执行，后台进行安全检查。', icon: Zap },
  { mode: 'plan', label: '计划模式', description: '先分析和规划，暂不直接修改。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: '跳过权限确认，风险更高。', icon: Shield, tone: 'warning' },
];

const CODEX_PERMISSION_OPTIONS: Array<{
  mode: AgentExecutionMode;
  label: string;
  description: string;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
}> = [
  { mode: 'auto_edit', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问。', icon: Hand },
  { mode: 'auto_review', label: '帮我批准', description: '仅对检测到的风险操作请求批准。', icon: ShieldCheck },
  { mode: 'full_access', label: '完全访问', description: '可不受限制地访问互联网和你电脑上的任何文件。', icon: Shield, tone: 'warning' },
];

function claudePermissionModeToExecutionMode(mode: ClaudePermissionMode): AgentExecutionMode {
  switch (mode) {
    case 'acceptEdits':
      return 'auto_edit';
    case 'auto':
      return 'auto_review';
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
      return 'full_access';
    case 'default':
    case 'dontAsk':
    default:
      return 'confirm_before_edit';
  }
}

function codexPermissionConfigToExecutionMode(config: { workflowMode: CodexWorkflowMode }): AgentExecutionMode {
  return codexWorkflowModeToExecutionMode(config.workflowMode);
}

export function AgentSettingsPanel() {
  useModelDisplayNames();
  const config = useSettingsStore((state) => state.config);
  const getDefaultAgentKind = useSettingsStore((state) => state.getDefaultAgentKind);
  const setDefaultAgentKind = useSettingsStore((state) => state.setDefaultAgentKind);
  const updateAgentConfig = useSettingsStore((state) => state.updateAgentConfig);
  const proxyRunning = useSettingsStore((state) => state.proxyRunning);
  const proxyUrl = useSettingsStore((state) => state.proxyUrl);

  const selectedKind = config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();

  const [runtimeResult, setRuntimeResult] = useState<AgentRuntimeCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [upgradingKind, setUpgradingKind] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [pendingUpgrade, setPendingUpgrade] = useState<{
    agentKind: string;
    label: string;
    report: AgentInstallationReport;
    action: 'upgrade' | 'install';
  } | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [installationReports, setInstallationReports] = useState<Record<string, AgentInstallationReport>>({});

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const result = await shellFacade.checkAgentRuntimes();
      setRuntimeResult(result.runtimes);
      setCheckedAt(result.checkedAt);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const handleUpgradeToast = useCallback(
    (result: AgentRuntimeUpgradeResult, toastId: string | number, action: 'upgrade' | 'install' = 'upgrade') => {
      const successLabel = action === 'install' ? '安装成功' : '升级成功';
      const failureLabel = action === 'install' ? '安装失败' : '升级失败';
      switch (result.outcome) {
        case 'success':
          toast.success(`${successLabel},当前版本:${result.newVersion ?? '未知'}`, { id: toastId });
          break;
        case 'soft_version_unchanged':
          toast.warning('命令已执行但版本未变,可能升级写入非默认位置,已自动诊断', { id: toastId });
          break;
        case 'soft_not_runnable':
          toast.warning('命令已执行但 CLI 无法运行,已自动诊断', { id: toastId });
          break;
        case 'hard_failure':
          toast.error(`${failureLabel}:${result.message}`, { id: toastId });
          break;
      }
    },
    [],
  );

  const diagnoseInstallations = useCallback(async (agentKind: string, silent: boolean) => {
    try {
      const report = await shellFacade.probeAgentInstallations(agentKind);
      setInstallationReports((prev) => ({ ...prev, [agentKind]: report }));
    } catch (err) {
      if (!silent) {
        toast.error(`诊断失败:${err instanceof Error ? err.message : String(err)}`);
      }
      if (silent) {
        // 静默失败时清掉残留展示,避免展示过期诊断
        setInstallationReports((prev) => {
          const next = { ...prev };
          delete next[agentKind];
          return next;
        });
      }
    }
  }, []);

  const executeUpgrade = useCallback(
    async (agentKind: string, label: string, action: 'upgrade' | 'install' = 'upgrade') => {
      // upgradingKind 已在调用前(handleUpgrade / handleConfirmUpgrade)设置
      const actionLabel = action === 'install' ? '安装' : '升级';
      const toastId = toast.loading(`正在${actionLabel} ${label}...`);
      try {
        const result = await shellFacade.upgradeAgentRuntime(agentKind);
        // 按 outcome 分级展示 toast
        handleUpgradeToast(result, toastId, action);
        // 升级后补诊(静默),结果写入对应卡片
        await diagnoseInstallations(agentKind, true);
        // 刷新所有卡片版本
        await runCheck();
      } catch (err) {
        toast.error(`${label} ${actionLabel}失败:${err instanceof Error ? err.message : String(err)}`, {
          id: toastId,
        });
      } finally {
        setUpgradingKind(null);
      }
    },
    [runCheck, diagnoseInstallations, handleUpgradeToast],
  );

  const handleUpgrade = useCallback(
    async (agentKind: string, label: string, action: 'upgrade' | 'install' = 'upgrade') => {
      if (upgradingKind) return;
      setUpgradingKind(agentKind);
      try {
        // 升级/安装前先检测多处安装,决定是否需要用户确认
        const report = await shellFacade.probeAgentInstallations(agentKind);
        if (report.needsConfirmation) {
          setPendingUpgrade({ agentKind, label, report, action });
          setConfirmDialogOpen(true);
          return;
        }
        await executeUpgrade(agentKind, label, action);
      } catch (err) {
        // 探测失败:解锁并提示
        setUpgradingKind(null);
        toast.error(`检测失败:${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [upgradingKind, executeUpgrade],
  );

  const handleConfirmUpgrade = useCallback(() => {
    setConfirmDialogOpen(false);
    const pending = pendingUpgrade;
    setPendingUpgrade(null);
    if (pending) {
      void executeUpgrade(pending.agentKind, pending.label, pending.action);
    }
  }, [pendingUpgrade, executeUpgrade]);

  const handleCancelUpgrade = useCallback(() => {
    setConfirmDialogOpen(false);
    setPendingUpgrade(null);
    // 解除升级锁定,允许用户再次操作
    setUpgradingKind(null);
  }, []);

  const claudePermissionMode: ClaudePermissionMode =
    config?.agent_configs.claude_code.permission_config?.permissionMode ?? 'default';
  const claudeExecutionMode = claudePermissionModeToExecutionMode(claudePermissionMode);

  const handleClaudePermissionChange = useCallback(
    (mode: AgentExecutionMode) => {
      const nextConfig: AgentPermissionConfig = mapExecutionModeToPermissionConfig('claude_code', mode);
      if (nextConfig.kind === 'claude_code') {
        updateAgentConfig('claude_code', {
          permission_config: nextConfig,
        });
      }
    },
    [updateAgentConfig],
  );

  return (
    <div className="space-y-8">
      <RuntimeDetectionSection
        runtimes={runtimeResult}
        checking={checking}
        checkError={checkError}
        checkedAt={checkedAt}
        onRefresh={runCheck}
        onUpgrade={handleUpgrade}
        upgradingKind={upgradingKind}
        selectedKind={selectedKind}
        onSelectDefault={setDefaultAgentKind}
        installationReports={installationReports}
      />

      <ClaudePermissionSection
        executionMode={claudeExecutionMode}
        onChange={handleClaudePermissionChange}
      />

      <ProxyRouteSection proxyRunning={proxyRunning} proxyUrl={proxyUrl} />

      <AgentUpgradeConfirmDialog
        open={confirmDialogOpen}
        report={pendingUpgrade?.report ?? null}
        onConfirm={handleConfirmUpgrade}
        onCancel={handleCancelUpgrade}
      />
    </div>
  );
}

/**
 * 智能体与 Runtime 合并页使用的偏好设置区。
 *
 * 全局 CLI 的检测与托管 Runtime 管理由 RuntimeSettingsPanel 负责，
 * 这里仅保留会话真正使用的默认引擎、权限和代理配置。
 */
export function AgentPreferencesPanel() {
  const config = useSettingsStore((state) => state.config);
  const getDefaultAgentKind = useSettingsStore((state) => state.getDefaultAgentKind);
  const setDefaultAgentKind = useSettingsStore((state) => state.setDefaultAgentKind);
  const updateAgentConfig = useSettingsStore((state) => state.updateAgentConfig);
  const proxyRunning = useSettingsStore((state) => state.proxyRunning);
  const proxyUrl = useSettingsStore((state) => state.proxyUrl);
  const selectedKind = config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
  const claudePermissionMode: ClaudePermissionMode =
    config?.agent_configs.claude_code.permission_config?.permissionMode ?? 'default';
  const codexPermissionConfig = config?.agent_configs.codex?.permission_config;
  const codexExecutionMode = codexPermissionConfig
    ? codexPermissionConfigToExecutionMode(codexPermissionConfig)
    : codexPermissionConfigToExecutionMode({ workflowMode: 'auto' });
  const openCodeAutoApprove = config?.agent_configs.opencode?.permission_config?.autoApprovePermissions ?? false;
  const piExecutionMode = config?.agent_configs.pi?.permission_config?.executionMode ?? 'confirm_before_edit';

  const handleClaudePermissionChange = useCallback(
    (mode: AgentExecutionMode) => {
      const nextConfig: AgentPermissionConfig = mapExecutionModeToPermissionConfig('claude_code', mode);
      if (nextConfig.kind === 'claude_code') {
        updateAgentConfig('claude_code', { permission_config: nextConfig });
      }
    },
    [updateAgentConfig],
  );

  const handleCodexPermissionChange = useCallback(
    (mode: AgentExecutionMode) => {
      const nextConfig: AgentPermissionConfig = mapExecutionModeToPermissionConfig('codex', mode);
      if (nextConfig.kind === 'codex') {
        updateAgentConfig('codex', { permission_config: nextConfig });
      }
    },
    [updateAgentConfig],
  );

  const handleOpenCodeAutoApproveChange = useCallback(
    (enabled: boolean) => {
      updateAgentConfig('opencode', {
        permission_config: { kind: 'opencode', autoApprovePermissions: enabled },
      });
    },
    [config, updateAgentConfig],
  );

  const handlePiPermissionChange = useCallback(
    (mode: AgentExecutionMode) => {
      const nextConfig: AgentPermissionConfig = mapExecutionModeToPermissionConfig('pi', mode);
      if (nextConfig.kind !== 'pi') {
        return;
      }
      void updateAgentConfig('pi', {
        permission_config: nextConfig,
      });
    },
    [updateAgentConfig],
  );

  return (
    <div className="space-y-8">
      <AgentConfigurationSection
        selectedKind={selectedKind}
        onSelectDefault={setDefaultAgentKind}
        claudeExecutionMode={claudePermissionModeToExecutionMode(claudePermissionMode)}
        onClaudePermissionChange={handleClaudePermissionChange}
        codexExecutionMode={codexExecutionMode}
        onCodexPermissionChange={handleCodexPermissionChange}
        openCodeAutoApprove={openCodeAutoApprove}
        onOpenCodeAutoApproveChange={handleOpenCodeAutoApproveChange}
        piExecutionMode={piExecutionMode}
        onPiPermissionChange={handlePiPermissionChange}
      />
      <ProxyRouteSection proxyRunning={proxyRunning} proxyUrl={proxyUrl} />
    </div>
  );
}

interface AgentConfigurationSectionProps {
  selectedKind: AgentKind;
  onSelectDefault: (kind: AgentKind) => void;
  claudeExecutionMode: AgentExecutionMode;
  onClaudePermissionChange: (mode: AgentExecutionMode) => void;
  codexExecutionMode: AgentExecutionMode;
  onCodexPermissionChange: (mode: AgentExecutionMode) => void;
  openCodeAutoApprove: boolean;
  onOpenCodeAutoApproveChange: (enabled: boolean) => void;
  piExecutionMode: AgentExecutionMode;
  onPiPermissionChange: (mode: AgentExecutionMode) => void;
}

function AgentConfigurationSection({
  selectedKind,
  onSelectDefault,
  claudeExecutionMode,
  onClaudePermissionChange,
  codexExecutionMode,
  onCodexPermissionChange,
  openCodeAutoApprove,
  onOpenCodeAutoApproveChange,
  piExecutionMode,
  onPiPermissionChange,
}: AgentConfigurationSectionProps) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">智能体配置</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          为每个智能体配置新建会话的默认模型；支持特殊配置的智能体也会显示在对应卡片中。
        </p>
      </div>
      <div className="grid gap-3">
        {RUNTIME_AGENTS.map((entry) => (
          <AgentConfigurationCard
            key={entry.kind}
            agent={entry}
            isDefault={entry.kind === selectedKind}
            onSelectDefault={() => onSelectDefault(entry.kind)}
            claudeExecutionMode={entry.kind === 'claude_code' ? claudeExecutionMode : undefined}
            onClaudePermissionChange={onClaudePermissionChange}
            codexExecutionMode={entry.kind === 'codex' ? codexExecutionMode : undefined}
            onCodexPermissionChange={onCodexPermissionChange}
            openCodeAutoApprove={entry.kind === 'opencode' ? openCodeAutoApprove : undefined}
            onOpenCodeAutoApproveChange={onOpenCodeAutoApproveChange}
            piExecutionMode={entry.kind === 'pi' ? piExecutionMode : undefined}
            onPiPermissionChange={onPiPermissionChange}
          />
        ))}
      </div>
    </section>
  );
}

interface AgentConfigurationCardProps {
  agent: (typeof RUNTIME_AGENTS)[number];
  isDefault: boolean;
  onSelectDefault: () => void;
  claudeExecutionMode?: AgentExecutionMode;
  onClaudePermissionChange: (mode: AgentExecutionMode) => void;
  codexExecutionMode?: AgentExecutionMode;
  onCodexPermissionChange: (mode: AgentExecutionMode) => void;
  openCodeAutoApprove?: boolean;
  onOpenCodeAutoApproveChange: (enabled: boolean) => void;
  piExecutionMode?: AgentExecutionMode;
  onPiPermissionChange?: (mode: AgentExecutionMode) => void;
}

function AgentConfigurationCard({
  agent,
  isDefault,
  onSelectDefault,
  claudeExecutionMode,
  onClaudePermissionChange,
  codexExecutionMode,
  onCodexPermissionChange,
  openCodeAutoApprove,
  onOpenCodeAutoApproveChange,
  piExecutionMode,
  onPiPermissionChange,
}: AgentConfigurationCardProps) {
  const definition = getAgentDefinition(agent.kind);
  const agentDefinition = definition ?? {
    kind: agent.kind,
    label: agent.label,
    description: '',
    icon: agent.icon,
    capabilities: [],
  };

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border p-4 transition-colors',
        isDefault
          ? 'border-[hsl(var(--primary)/0.32)] bg-[hsl(var(--primary)/0.06)]'
          : 'border-border/55 bg-background/60',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-background/78">
          <AgentBrandIcon agent={agentDefinition} size="md" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-foreground">{agent.label}</h4>
            {isDefault && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[hsl(var(--primary)/0.14)] px-2 py-0.5 text-ui-micro font-medium text-[hsl(var(--primary))]">
                <Check className="h-3 w-3" />
                默认
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {agentDefinition.description}
          </p>
        </div>
        {!isDefault && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
            onClick={onSelectDefault}
          >
            设为默认
          </Button>
        )}
      </div>

      <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border/50 pt-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex shrink-0 items-center gap-3 lg:w-44">
          <span className="text-xs font-medium text-foreground">新建会话默认模型</span>
        </div>
        <div className="min-w-0 w-full lg:w-72 lg:flex-none">
          <AgentModelSelect agentKind={agent.kind} />
        </div>
      </div>

      {agent.kind === 'claude_code' && claudeExecutionMode && (
        <ClaudePermissionSection
          compact
          executionMode={claudeExecutionMode}
          onChange={onClaudePermissionChange}
        />
      )}
      {agent.kind === 'codex' && codexExecutionMode && (
        <CodexPermissionSection
          compact
          executionMode={codexExecutionMode}
          onChange={onCodexPermissionChange}
        />
      )}
      {agent.kind === 'opencode' && openCodeAutoApprove != null && (
        <OpenCodeAutoApproveSection
          enabled={openCodeAutoApprove}
          onChange={onOpenCodeAutoApproveChange}
        />
      )}
      {agent.kind === 'pi' && piExecutionMode && onPiPermissionChange && (
        <PiPermissionSection
          executionMode={piExecutionMode}
          onChange={onPiPermissionChange}
        />
      )}
    </article>
  );
}

/* ------------------------------- pi 默认权限区 ------------------------------ */

const PI_PERMISSION_OPTIONS: Array<{ mode: AgentExecutionMode; label: string }> = [
  { mode: 'confirm_before_edit', label: '变更前确认' },
  { mode: 'auto_edit', label: '自动编辑' },
  { mode: 'full_access', label: '完全访问' },
];

function PiPermissionSection({
  executionMode,
  onChange,
}: {
  executionMode: AgentExecutionMode;
  onChange: (mode: AgentExecutionMode) => void;
}) {
  return (
    <section className="mt-4 flex min-w-0 flex-col gap-2 border-t border-border/50 pt-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="shrink-0 space-y-1 lg:w-44">
        <h3 className="text-sm font-semibold text-foreground">pi 默认权限</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">新建对话时默认使用的审批级别。</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          不会加载项目内 .pi 的设置与扩展：pi 以无界面模式运行，无法询问项目信任，按默认拒绝处理。
        </p>
      </div>
      <div className="w-full lg:w-72 lg:flex-none">
        <Select value={executionMode} onValueChange={(value) => onChange(value as AgentExecutionMode)}>
          <SelectTrigger aria-label="pi 默认权限" className="h-9 w-full">
            <SelectValue placeholder="选择默认权限" />
          </SelectTrigger>
          <SelectContent>
            {PI_PERMISSION_OPTIONS.map((option) => (
              <SelectItem key={option.mode} value={option.mode}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

function AgentModelSelect({ agentKind }: { agentKind: AgentKind }) {
  const config = useSettingsStore((state) => state.config);
  const updateAgentConfig = useSettingsStore((state) => state.updateAgentConfig);
  const providers = config?.model_providers ?? [];
  const freeModels = useOpenCodeFreeModelOptions(agentKind);
  const agentConfig = config?.agent_configs[agentKind] as {
    default_provider_id?: string | null;
    default_model?: string;
  } | undefined;
  const usableProviders = providers.filter((provider) => isProviderUsable(provider, agentKind));
  const providerId = agentConfig?.default_provider_id
    ?? config?.active_provider_id
    ?? usableProviders[0]?.id
    ?? '';
  // 免费模型默认绑定虚拟供应商 `opencode-free`(ADR 0017),不对应
  // ModelProvider 记录;选中态与条目单独解析。
  const isFreeSelection = providerId === OPENCODE_FREE_PROVIDER_ID;
  const provider = usableProviders.find((item) => item.id === providerId) ?? usableProviders[0];
  const modelId = agentConfig?.default_model
    ?? provider?.default_model
    ?? provider?.models[0]?.id
    ?? '';
  const selectedModel = provider?.models.find((model) => model.id === modelId)
    ?? provider?.models[0];
  const selectedFreeModel = isFreeSelection
    ? freeModels.find((model) => model.modelId === (agentConfig?.default_model ?? '').trim()) ?? null
    : null;
  const combinedValue = isFreeSelection
    ? (selectedFreeModel
      ? `${OPENCODE_FREE_PROVIDER_ID}::${selectedFreeModel.modelId}`
      : '')
    : (provider && selectedModel
      ? `${provider.id}::${selectedModel.id}`
      : '');

  const saveDefault = (value: string) => {
    const separator = value.indexOf('::');
    if (separator <= 0) return;
    void updateAgentConfig(agentKind, {
      default_provider_id: value.slice(0, separator),
      default_model: value.slice(separator + 2),
    });
  };

  return (
    <Select
      value={combinedValue}
      onValueChange={saveDefault}
      disabled={usableProviders.length === 0 && freeModels.length === 0}
    >
      <SelectTrigger aria-label={`${getAgentDefinition(agentKind)?.label ?? agentKind} 默认供应商和模型`} className="h-9">
        <SelectValue placeholder="暂无可用供应商或模型">
          {isFreeSelection && selectedFreeModel ? (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderBrandIcon
                templateId={selectedFreeModel.providerTemplateId}
                name={selectedFreeModel.group}
                size={14}
                className="h-5 w-5 rounded-[5px]"
              />
              <span className="truncate">{selectedFreeModel.name}</span>
            </span>
          ) : provider && selectedModel ? (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderBrandIcon
                templateId={provider.builtin_template_id}
                name={provider.name}
                size={14}
                className="h-5 w-5 rounded-[5px]"
              />
              <span className="truncate">
                {resolveModelDisplayName({
                  id: selectedModel.id,
                  name: selectedModel.name,
                  providerTemplateId: provider.builtin_template_id,
                })}
              </span>
            </span>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {usableProviders.map((item) => (
          <SelectGroup key={item.id}>
            <SelectLabel>{item.name}</SelectLabel>
            {item.models.map((model) => (
              <SelectItem key={`${item.id}::${model.id}`} value={`${item.id}::${model.id}`}>
                <span className="flex items-center gap-2">
                  <ProviderBrandIcon
                    templateId={item.builtin_template_id}
                    name={item.name}
                    size={14}
                    className="h-5 w-5 rounded-[5px]"
                  />
                  <span>
                    {resolveModelDisplayName({
                      id: model.id,
                      name: model.name,
                      providerTemplateId: item.builtin_template_id,
                    })}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {freeModels.length > 0 && (
          <SelectGroup>
            <SelectLabel>{OPENCODE_FREE_GROUP}</SelectLabel>
            {freeModels.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <span className="flex items-center gap-2">
                  <ProviderBrandIcon
                    templateId={model.providerTemplateId}
                    name={model.group}
                    size={14}
                    className="h-5 w-5 rounded-[5px]"
                  />
                  <span>{model.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

/* ----------------------------- 运行时检测区 ----------------------------- */

interface RuntimeDetectionSectionProps {
  runtimes: AgentRuntimeCheck[] | null;
  checking: boolean;
  checkError: string | null;
  checkedAt: string | null;
  onRefresh: () => void;
  onUpgrade: (agentKind: string, label: string, action: 'upgrade' | 'install') => void;
  upgradingKind: string | null;
  selectedKind: AgentKind;
  onSelectDefault: (kind: AgentKind) => void;
  installationReports: Record<string, AgentInstallationReport>;
}

// 运行时检测支持的智能体(与 Rust AGENT_SPECS 对齐,用于加载骨架)
const RUNTIME_AGENTS: Array<{ kind: AgentKind; label: string; icon: 'claude' | 'codex' | 'opencode' | 'pi' }> = [
  { kind: 'claude_code', label: 'Claude Code', icon: 'claude' },
  { kind: 'codex', label: 'Codex', icon: 'codex' },
  { kind: 'opencode', label: 'OpenCode', icon: 'opencode' },
  { kind: 'pi', label: 'pi', icon: 'pi' },
];

function RuntimeDetectionSection({
  runtimes,
  checking,
  checkError,
  checkedAt,
  onRefresh,
  onUpgrade,
  upgradingKind,
  selectedKind,
  onSelectDefault,
  installationReports,
}: RuntimeDetectionSectionProps) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">运行时环境检测</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            一键检测本机已安装的 Claude Code、Codex、OpenCode CLI，显示命令路径、配置文件、当前版本与最新版本。点击卡片可设为默认智能体引擎。
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onRefresh} disabled={checking}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {checking ? '检测中...' : '一键检测'}
        </Button>
      </div>

      {checkError && (
        <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          环境检测失败：{checkError}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {checking && !runtimes
          ? RUNTIME_AGENTS.map((agent) => (
              <RuntimeSkeletonCard key={agent.kind} label={agent.label} iconKind={agent.icon} />
            ))
          : runtimes?.map((runtime) => (
              <RuntimeCard
                key={runtime.agentKind}
                runtime={runtime}
                isDefault={runtime.agentKind === selectedKind}
                onSelectDefault={() => onSelectDefault(runtime.agentKind as AgentKind)}
                onUpgrade={(action) => onUpgrade(runtime.agentKind, runtime.label, action)}
                upgrading={upgradingKind === runtime.agentKind}
                anyUpgrading={upgradingKind !== null}
                installationReport={installationReports[runtime.agentKind]}
              />
            ))}
      </div>

      {checkedAt && (
        <p className="text-xs text-muted-foreground">检测时间：{formatCheckedAt(checkedAt)}</p>
      )}
    </section>
  );
}

/* ----------------------------- 骨架卡片(加载中) ----------------------------- */

function RuntimeSkeletonCard({
  label,
  iconKind,
}: {
  label: string;
  iconKind: 'claude' | 'codex' | 'opencode' | 'pi';
}) {
  return (
    <div className="flex animate-pulse flex-col gap-3 rounded-2xl border border-border/40 bg-background/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-muted/40">
            <AgentBrandIcon agent={{ kind: 'claude_code' as AgentKind, label: '', description: '', icon: iconKind, capabilities: [] }} size="md" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="text-sm font-semibold text-foreground">{label}</div>
            <div className="h-3 w-32 rounded bg-muted/60" />
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-ui-caption text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          检测中
        </span>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="h-3 w-16 rounded bg-muted/50" />
          <div className="h-3 w-40 rounded bg-muted/50" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="h-3 w-16 rounded bg-muted/50" />
          <div className="h-3 w-40 rounded bg-muted/50" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="h-3 w-16 rounded bg-muted/50" />
          <div className="h-3 w-20 rounded bg-muted/50" />
        </div>
      </div>
    </div>
  );
}

interface RuntimeCardProps {
  runtime: AgentRuntimeCheck;
  isDefault: boolean;
  onSelectDefault: () => void;
  onUpgrade: (action: 'upgrade' | 'install') => void;
  upgrading: boolean;
  anyUpgrading?: boolean;
  installationReport?: AgentInstallationReport;
}

export function RuntimeCard({
  runtime,
  isDefault,
  onSelectDefault,
  onUpgrade,
  upgrading,
  anyUpgrading = false,
  installationReport,
}: RuntimeCardProps) {
  const meta = RUNTIME_STATUS_META[runtime.status];
  const StatusIcon = meta.icon;
  const definition = getAgentDefinition(runtime.agentKind as AgentKind);
  const agent = definition ?? {
    kind: runtime.agentKind as AgentKind,
    label: runtime.label,
    description: '',
    icon: 'claude' as const,
    capabilities: [],
  };

  // 三态探测:installed_but_broken=true 时展示差异化文案
  const isBroken = runtime.installedButBroken === true;
  const description = isBroken
    ? `已安装但无法运行：${summarizeBrokenMessage(runtime.message)}`
    : definition?.description ?? runtime.message;

  const showUpgrade = runtime.status === 'outdated' && Boolean(runtime.latestVersion);
  const showInstall = runtime.status === 'missing';
  // CLI 可运行时在路径行展示绿色圆点指示器
  const showInstalledDot = runtime.status === 'ok' || runtime.status === 'outdated';
  const { executablePath, configPath, currentVersion, latestVersion } = runtime;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
        isDefault
          ? 'border-[hsl(var(--primary)/0.32)] bg-[hsl(var(--primary)/0.06)]'
          : 'border-border/55 bg-background/60 hover:border-border/80',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-background/78">
            <AgentBrandIcon agent={agent} size="md" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-foreground">{runtime.label}</div>
              {isDefault && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--primary)/0.14)] px-2 py-0.5 text-ui-micro font-medium uppercase tracking-[0.12em] text-[hsl(var(--primary))]">
                  <Check className="h-3 w-3" />
                  默认
                </span>
              )}
            </div>
            <p
              className={cn(
                'text-xs leading-5 text-muted-foreground',
                // broken 文案需要完整展示错误摘要,不强制两行截断
                !isBroken && 'line-clamp-2',
              )}
            >
              {description}
            </p>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-ui-caption font-medium',
            meta.className,
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {meta.label}
        </span>
      </div>

      <div className="space-y-1.5 text-xs">
        <RuntimeInfoRow
          label="命令路径"
          value={executablePath ?? '未找到'}
          mono
          empty={!executablePath}
          indicator={showInstalledDot ? 'installed' : undefined}
        />
        <RuntimeInfoRow
          label="配置文件"
          value={configPath ?? '未找到'}
          mono
          empty={!configPath}
        />
        <div className="flex items-center justify-between gap-2">
          <RuntimeInfoRow
            label="当前版本"
            value={currentVersion ?? '-'}
            mono
            empty={!currentVersion}
          />
          <RuntimeInfoRow
            label="最新版本"
            value={latestVersion ?? '-'}
            mono
            empty={!latestVersion}
          />
        </div>
      </div>

      {installationReport && installationReport.installs.length > 1 && (
        <div className="mt-3 border-t border-dashed border-border/55 pt-3">
          <div className="mb-1.5 text-ui-caption text-muted-foreground">
            检测到 {installationReport.installs.length} 处安装
            {installationReport.isConflict && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">· 版本冲突</span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            {installationReport.installs.map((install, idx) => (
              <AgentInstallRow key={`${install.path}-${idx}`} install={install} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-1 flex items-center justify-between gap-2">
        {/* 左侧:设为默认 */}
        <div>
          {!isDefault && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={onSelectDefault}
              disabled={anyUpgrading}
            >
              设为默认
            </Button>
          )}
        </div>
        {/* 右侧:安装/升级 */}
        <div>
          {showInstall && (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="gap-1.5"
              onClick={() => onUpgrade('install')}
              disabled={anyUpgrading}
            >
              {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {upgrading ? '安装中...' : '安装'}
            </Button>
          )}
          {showUpgrade && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => onUpgrade('upgrade')}
              disabled={anyUpgrading}
            >
              {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {upgrading ? '升级中...' : `升级到 ${latestVersion}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface RuntimeInfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
  empty?: boolean;
  indicator?: 'installed';
}

function RuntimeInfoRow({ label, value, mono, empty, indicator }: RuntimeInfoRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-ui-caption text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        {indicator === 'installed' && !empty && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--success))]"
            aria-label="已安装"
          />
        )}
        <TooltipHint content={value}>
          <span
            className={cn(
              'truncate text-ui-meta',
              mono && 'font-mono',
              empty ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {value}
          </span>
        </TooltipHint>
      </div>
    </div>
  );
}

/* ----------------------------- 本地代理路由区 ----------------------------- */

interface ProxyRouteSectionProps {
  proxyRunning: boolean;
  proxyUrl: string | null;
}

function ProxyRouteSection({ proxyRunning, proxyUrl }: ProxyRouteSectionProps) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">本地代理路由</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          为 Codex 等智能体提供本地兼容代理，由档案配置在启动会话时自动管理。
        </p>
      </div>
      <div className="rounded-2xl border border-border/45 bg-muted/15 p-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              {proxyRunning ? (
                <CircleDot className="h-4 w-4 text-[hsl(var(--success))]" />
              ) : (
                <CircleDot className="h-4 w-4 text-muted-foreground" />
              )}
              {proxyRunning ? '运行中' : '按需启动'}
            </h4>
            <p className="text-xs leading-5 text-muted-foreground">
              {proxyRunning
                ? <>地址 · <span className="font-mono">{proxyUrl || '等待地址...'}</span></>
                : '由档案配置在启动 Codex 会话时自动管理。'}
            </p>
          </div>
          <span
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium',
              proxyRunning
                ? 'border-[hsl(var(--success)/0.28)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]'
                : 'border-border/55 bg-muted/35 text-muted-foreground',
            )}
          >
            {proxyRunning ? '自动运行' : '按需启动'}
          </span>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- Codex 默认权限区 ----------------------------- */

interface CodexPermissionSectionProps {
  compact?: boolean;
  executionMode: AgentExecutionMode;
  onChange: (mode: AgentExecutionMode) => void;
}

function CodexPermissionSection({
  compact = false,
  executionMode,
  onChange,
}: CodexPermissionSectionProps) {
  const selectedOption = useMemo(
    () => CODEX_PERMISSION_OPTIONS.find((option) => option.mode === executionMode) ?? CODEX_PERMISSION_OPTIONS[0],
    [executionMode],
  );

  if (compact) {
    return (
      <section className="mt-4 flex min-w-0 flex-col gap-2 border-t border-border/50 pt-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0 space-y-1 lg:w-44">
          <h3 className="text-sm font-semibold text-foreground">Codex 默认权限</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">新建对话时默认使用的审批级别。</p>
        </div>
        <div className="w-full lg:w-72 lg:flex-none">
          <Select value={executionMode} onValueChange={(value) => onChange(value as AgentExecutionMode)}>
            <SelectTrigger aria-label="Codex 默认权限" className="h-9 w-full">
              <SelectValue placeholder="选择默认权限" />
            </SelectTrigger>
            <SelectContent>
              {CODEX_PERMISSION_OPTIONS.map((option) => (
                <SelectItem key={option.mode} value={option.mode}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Codex 默认权限</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          控制新建 Codex 对话时默认选中的审批级别，与发送框下拉保持一致。
        </p>
      </div>
      <div className={cn('grid gap-2 sm:grid-cols-2', compact && 'sm:grid-cols-1')}>
        {CODEX_PERMISSION_OPTIONS.map((option) => {
          const active = option.mode === selectedOption.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              onClick={() => onChange(option.mode)}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-normal',
                active
                  ? 'border-[hsl(var(--primary)/0.32)] bg-[hsl(var(--primary)/0.06)]'
                  : 'border-border/55 bg-background hover:border-border hover:bg-muted/25',
                option.tone === 'warning' && !active && 'hover:border-orange-500/35',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                  active
                    ? 'border-[hsl(var(--primary)/0.22)] bg-[hsl(var(--primary)/0.14)] text-[hsl(var(--primary))]'
                    : option.tone === 'warning'
                      ? 'border-border/55 text-orange-500'
                      : 'border-border/55 text-muted-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-ui-caption leading-4 text-muted-foreground">{option.description}</span>
              </span>
              {active && (
                <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------- OpenCode 自动接受权限区 ----------------------------- */

interface OpenCodeAutoApproveSectionProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

function OpenCodeAutoApproveSection({ enabled, onChange }: OpenCodeAutoApproveSectionProps) {
  return (
    <section className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border/50 pt-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 space-y-1 lg:flex-1">
        <h3 className="text-sm font-semibold text-foreground">自动接受权限</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          开启后，原本需要确认的权限请求将自动通过；显式拒绝的规则仍由 OpenCode 服务端强制执行。
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 lg:w-72 lg:justify-end">
        <span className="text-xs text-muted-foreground">{enabled ? '已开启' : '已关闭'}</span>
        <Switch
          checked={enabled}
          onCheckedChange={onChange}
          aria-label="自动接受权限"
        />
      </div>
    </section>
  );
}

/* ----------------------------- Claude Code 默认权限区 ----------------------------- */

interface ClaudePermissionSectionProps {
  compact?: boolean;
  executionMode: AgentExecutionMode;
  onChange: (mode: AgentExecutionMode) => void;
}

function ClaudePermissionSection({
  compact = false,
  executionMode,
  onChange,
}: ClaudePermissionSectionProps) {
  const selectedOption = useMemo(
    () => CLAUDE_PERMISSION_OPTIONS.find((option) => option.mode === executionMode) ?? CLAUDE_PERMISSION_OPTIONS[0],
    [executionMode],
  );

  if (compact) {
    return (
      <section className="mt-4 flex min-w-0 flex-col gap-2 border-t border-border/50 pt-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0 space-y-1 lg:w-44">
          <h3 className="text-sm font-semibold text-foreground">Claude Code 默认权限</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">新建对话时默认使用的工具权限。</p>
        </div>
        <div className="w-full lg:w-72 lg:flex-none">
          <Select value={executionMode} onValueChange={(value) => onChange(value as AgentExecutionMode)}>
            <SelectTrigger aria-label="Claude Code 默认权限" className="h-9 w-full">
              <SelectValue placeholder="选择默认权限" />
            </SelectTrigger>
            <SelectContent>
              {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                <SelectItem key={option.mode} value={option.mode}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Claude Code 默认权限</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          控制新建 Claude Code 对话时默认选中的工具权限行为，与发送框下拉保持一致。仍可在新建对话时手动切换。
        </p>
      </div>
      <div className={cn('grid gap-2 sm:grid-cols-2', compact && 'sm:grid-cols-1')}>
        {CLAUDE_PERMISSION_OPTIONS.map((option) => {
          const active = option.mode === selectedOption.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              onClick={() => onChange(option.mode)}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-normal',
                active
                  ? 'border-[hsl(var(--primary)/0.32)] bg-[hsl(var(--primary)/0.06)]'
                  : 'border-border/55 bg-background hover:border-border hover:bg-muted/25',
                option.tone === 'warning' && !active && 'hover:border-orange-500/35',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                  active
                    ? 'border-[hsl(var(--primary)/0.22)] bg-[hsl(var(--primary)/0.14)] text-[hsl(var(--primary))]'
                    : option.tone === 'warning'
                      ? 'border-border/55 text-orange-500'
                      : 'border-border/55 text-muted-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-ui-caption leading-4 text-muted-foreground">{option.description}</span>
              </span>
              {active && (
                <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------- 辅助函数 ----------------------------- */

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

// installed_but_broken 副文案摘要:超过 120 字符截断加 "…"
function summarizeBrokenMessage(message: string): string {
  if (message.length > 120) {
    return message.slice(0, 120) + '…';
  }
  return message;
}
