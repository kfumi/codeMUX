import {
  Check,
  ChevronDown,
  ClipboardList,
  Hand,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildDefaultPermissionConfig,
  mapExecutionModeToPermissionConfig,
  type AgentExecutionMode,
  type AgentPermissionConfig,
  type AgentPlanMode,
} from '../../lib/agentPermissions';
import { cn } from '../../lib/utils';
import type { AgentKind } from '../../types/session';
import type { AgentPermissionRequest, AgentPermissionResponse } from '../../types/agent';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

interface AgentPermissionSelectorProps {
  agentKind: AgentKind;
  permissionConfig?: AgentPermissionConfig | null;
  planMode: AgentPlanMode;
  disabled?: boolean;
  onPermissionConfigChange: (permissionConfig: AgentPermissionConfig) => void;
  onPlanModeChange: (planMode: AgentPlanMode) => void;
  /** Atomic callback — updates both config and plan mode in a single call to avoid race conditions. */
  onModeChange?: (config: AgentPermissionConfig, planMode: AgentPlanMode) => void;
  /** Called once when a legacy Codex config (e.g. workspace-write) is detected and needs migration. */
  onLegacyConfigMigrate?: (migratedConfig: AgentPermissionConfig) => void;
  /** 紧凑模式：只显示图标，隐藏文字标签 */
  compact?: boolean;
  rawPermissionType?: string;
  rawPermissionDescription?: string;
  pendingPermission?: AgentPermissionRequest | null;
  onPermissionResponse?: (response: AgentPermissionResponse) => void;
  permissionResponsePending?: boolean;
}

type PermissionOption = {
  mode: AgentExecutionMode;
  label: string;
  description: string;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
};

const claudeOptions: PermissionOption[] = [
  { mode: 'confirm_before_edit', label: '变更前确认', description: '修改文件或运行敏感工具前先询问。', icon: Hand },
  { mode: 'auto_edit', label: '自动编辑', description: '允许 Claude 自动编辑文件。', icon: ShieldCheck },
  { mode: 'plan', label: '计划模式', description: '先分析和规划，暂不直接修改。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: '跳过权限确认，风险更高。', icon: Shield, tone: 'warning' },
];

const opencodeOptions: PermissionOption[] = [
  { mode: 'plan', label: '计划模式', description: '先分析和规划，暂不直接修改。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: 'OpenCode 使用服务端按工具配置的权限规则。', icon: Shield, tone: 'warning' },
];

const codexOptions: PermissionOption[] = [
  { mode: 'plan', label: '计划模式', description: '先分析和规划，不直接写入文件。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: '允许不受限访问文件和网络，风险更高。', icon: Shield, tone: 'warning' },
];

export function AgentPermissionSelector({
  agentKind,
  permissionConfig,
  planMode,
  disabled,
  onPermissionConfigChange,
  onPlanModeChange,
  onModeChange,
  onLegacyConfigMigrate,
  compact,
  rawPermissionType,
  rawPermissionDescription,
  pendingPermission,
  onPermissionResponse,
  permissionResponsePending,
}: AgentPermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  const normalized = permissionConfig ?? buildDefaultPermissionConfig(agentKind);
  const selectedMode = inferExecutionMode(agentKind, normalized, planMode);

  // Auto-migrate legacy Codex configs (e.g. workspace-write) to the current default
  // so the stored config matches what the UI displays.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    if (
      agentKind === 'codex' &&
      normalized.kind === 'codex' &&
      normalized.sandboxMode === 'workspace-write' &&
      planMode !== 'on' &&
      onLegacyConfigMigrate
    ) {
      migratedRef.current = true;
      onLegacyConfigMigrate({
        kind: 'codex',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      });
    }
  }, [agentKind, normalized, planMode, onLegacyConfigMigrate]);
  const options = agentKind === 'opencode' ? opencodeOptions : agentKind === 'codex' ? codexOptions : claudeOptions;
  const selected = useMemo(
    () => options.find((option) => option.mode === selectedMode) ?? options[0],
    [options, selectedMode],
  );
  const SelectedIcon = selected.icon;

  const selectMode = (mode: AgentExecutionMode) => {
    const nextConfig = mapExecutionModeToPermissionConfig(agentKind, mode);
    const nextPlanMode = (agentKind === 'claude_code' || agentKind === 'codex' || agentKind === 'opencode')
      ? (mode === 'plan' ? 'on' as const : 'off' as const)
      : planMode;

    // Prefer the atomic callback to avoid race conditions between
    // separate config and plan-mode state updates.
    if (onModeChange) {
      onModeChange(nextConfig, nextPlanMode);
    } else {
      onPermissionConfigChange(nextConfig);
      if (agentKind === 'claude_code' || agentKind === 'codex' || agentKind === 'opencode') {
        onPlanModeChange(nextPlanMode);
      }
    }
    setOpen(false);
  };

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-label={selected.label}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md border border-border/40 bg-[hsl(var(--surface-2))]/70 px-2 text-xs font-medium text-muted-foreground/78 transition-all duration-200 hover:bg-muted/58 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                    compact ? 'max-w-9' : 'max-w-40',
                    selected.tone === 'warning' && 'border-orange-500/35 text-orange-500 hover:text-orange-400',
                  )}
                >
                  <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
                  {!compact && <span className="truncate">{selected.label}</span>}
                  {!compact && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{selected.label}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PopoverContent
          side="top"
          sideOffset={8}
          align="start"
          className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1.5 shadow-[0_22px_54px_-28px_hsl(var(--foreground)/0.55)] backdrop-blur-lg"
        >
          {options.map((option) => {
            const active = selectedMode === option.mode;
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMode(option.mode)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/56',
                  active && 'bg-muted/64',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0 text-muted-foreground', option.tone === 'warning' && 'text-orange-500')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{option.label}</span>
                  <span className="block truncate text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                </span>
                {active && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      {pendingPermission && (
        <div data-testid="pending-agent-permission" className="mt-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 py-2 text-xs">
          <div className="font-medium text-foreground">需要权限确认</div>
          <div className="mt-1 font-mono text-foreground/90">{pendingPermission.permission_type}</div>
          <div className="mt-1 text-muted-foreground">{pendingPermission.description}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" disabled={permissionResponsePending} onClick={() => onPermissionResponse?.('once')}>允许一次</Button>
            <Button type="button" size="sm" variant="outline" disabled={permissionResponsePending} onClick={() => onPermissionResponse?.('always')}>始终允许</Button>
            <Button type="button" size="sm" variant="ghost" disabled={permissionResponsePending} onClick={() => onPermissionResponse?.('reject')}>拒绝</Button>
          </div>
        </div>
      )}
      {(rawPermissionType || rawPermissionDescription) && (
        <div
          data-testid="native-permission-details"
          className="mt-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-2 text-xs"
        >
          {rawPermissionType && <div className="font-mono text-foreground/90">{rawPermissionType}</div>}
          {rawPermissionDescription && <div className="mt-1 text-muted-foreground">{rawPermissionDescription}</div>}
        </div>
      )}
    </div>
  );
}

function inferExecutionMode(
  agentKind: AgentKind,
  permissionConfig: AgentPermissionConfig,
  planMode: AgentPlanMode,
): AgentExecutionMode {
  if (agentKind === 'opencode' && permissionConfig.kind === 'opencode') {
    if (planMode === 'on' || permissionConfig.permissionMode === 'plan') return 'plan';
    return 'full_access';
  }

  if (agentKind === 'codex' && permissionConfig.kind === 'codex') {
    if (planMode === 'on' || permissionConfig.sandboxMode === 'read-only') return 'plan';
    // workspace-write is a legacy mode that maps to full_access in the simplified UI.
    // The onLegacyConfigMigrate callback handles persisting the upgrade.
    return 'full_access';
  }

  if (agentKind === 'claude_code' && permissionConfig.kind === 'claude_code') {
    if (planMode === 'on' || permissionConfig.permissionMode === 'plan') return 'plan';
    if (permissionConfig.permissionMode === 'bypassPermissions') return 'full_access';
    if (permissionConfig.permissionMode === 'acceptEdits' || permissionConfig.permissionMode === 'auto') return 'auto_edit';
  }

  return 'confirm_before_edit';
}
