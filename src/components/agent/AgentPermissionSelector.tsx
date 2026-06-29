import {
  Check,
  ChevronDown,
  ClipboardList,
  Hand,
  Shield,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  buildDefaultPermissionConfig,
  mapExecutionModeToPermissionConfig,
  type AgentExecutionMode,
  type AgentPermissionConfig,
  type AgentPlanMode,
} from '../../lib/agentPermissions';
import { cn } from '../../lib/utils';
import type { AgentKind } from '../../types/session';

interface AgentPermissionSelectorProps {
  agentKind: AgentKind;
  permissionConfig?: AgentPermissionConfig | null;
  planMode: AgentPlanMode;
  disabled?: boolean;
  onPermissionConfigChange: (permissionConfig: AgentPermissionConfig) => void;
  onPlanModeChange: (planMode: AgentPlanMode) => void;
}

type PermissionOption = {
  mode: AgentExecutionMode;
  label: string;
  description: string;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
};

const claudeOptions: PermissionOption[] = [
  { mode: 'confirm_before_edit', label: '变更前确认', description: '改文件前先问我。', icon: Hand },
  { mode: 'auto_edit', label: '自动编辑', description: '自动编辑文件。', icon: ShieldCheck },
  { mode: 'plan', label: '计划模式', description: '编辑前先出计划。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: '减少确认次数。', icon: Shield, tone: 'warning' },
];

const codexOptions: PermissionOption[] = [
  { mode: 'confirm_before_edit', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问', icon: Hand },
  { mode: 'auto_edit', label: '替我审批', description: '仅对检测到的风险操作请求批准', icon: ShieldQuestion },
  { mode: 'full_access', label: '完全访问权限', description: '可不受限制地访问互联网和您电脑上的任何文件', icon: Shield, tone: 'warning' },
];

export function AgentPermissionSelector({
  agentKind,
  permissionConfig,
  planMode,
  disabled,
  onPermissionConfigChange,
  onPlanModeChange,
}: AgentPermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  const normalized = permissionConfig ?? buildDefaultPermissionConfig(agentKind);
  const selectedMode = inferExecutionMode(agentKind, normalized, planMode);
  const options = agentKind === 'codex' ? codexOptions : claudeOptions;
  const selected = useMemo(
    () => options.find((option) => option.mode === selectedMode) ?? options[0],
    [options, selectedMode],
  );
  const SelectedIcon = selected.icon;

  const selectMode = (mode: AgentExecutionMode) => {
    onPermissionConfigChange(mapExecutionModeToPermissionConfig(agentKind, mode));
    if (agentKind === 'claude_code') {
      onPlanModeChange(mode === 'plan' ? 'on' : 'off');
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={selected.label}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md border border-border/40 bg-[hsl(var(--surface-2))]/70 px-2 text-xs font-medium text-muted-foreground/78 transition-all duration-200 hover:bg-muted/58 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          selected.tone === 'warning' && 'border-orange-500/35 text-orange-500 hover:text-orange-400',
        )}
      >
        <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{selected.mode === 'full_access' && agentKind === 'codex' ? '完全访问' : selected.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1.5 shadow-[0_22px_54px_-28px_hsl(var(--foreground)/0.55)] backdrop-blur-lg"
        >
          {agentKind === 'codex' && (
            <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1 text-xs text-muted-foreground">
              <span>应如何批准 Codex 操作?</span>
              <span className="underline underline-offset-2">了解更多</span>
            </div>
          )}

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
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/56',
                  active && 'bg-muted/64',
                )}
              >
                <Icon className={cn('h-5 w-5 shrink-0 text-muted-foreground', option.tone === 'warning' && 'text-orange-500')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{option.label}</span>
                  <span className="block truncate text-xs leading-5 text-muted-foreground">{option.description}</span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
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
  if (agentKind === 'codex' && permissionConfig.kind === 'codex') {
    if (permissionConfig.sandboxMode === 'danger-full-access') return 'full_access';
    if (permissionConfig.approvalPolicy === 'never') return 'auto_edit';
    return 'confirm_before_edit';
  }

  if (agentKind === 'claude_code' && permissionConfig.kind === 'claude_code') {
    if (planMode === 'on' || permissionConfig.permissionMode === 'plan') return 'plan';
    if (permissionConfig.permissionMode === 'bypassPermissions') return 'full_access';
    if (permissionConfig.permissionMode === 'acceptEdits' || permissionConfig.permissionMode === 'auto') return 'auto_edit';
  }

  return 'confirm_before_edit';
}
