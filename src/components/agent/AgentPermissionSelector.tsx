import { Check, ChevronDown, Shield, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  applyTier,
  buildDefaultPermissionConfig,
  permissionMenu,
  serializePermissionConfig,
  type AgentExecutionMode,
  type AgentPermissionConfig,
  type AgentPlanMode,
  type AgentTier,
} from '../../lib/agentKind';
import { tierIcon } from './tierIcon';
import {
  COMPOSER_BAR_CONTROL_CLASS,
  COMPOSER_BAR_ICON_CONTROL_CLASS,
} from '../../lib/composerTokens';
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
  /** 紧凑模式：只显示图标，隐藏文字标签 */
  compact?: boolean;
  rawPermissionType?: string;
  rawPermissionDescription?: string;
  pendingPermission?: AgentPermissionRequest | null;
  onPermissionResponse?: (response: AgentPermissionResponse) => void;
  permissionResponsePending?: boolean;
}

export function AgentPermissionSelector({
  agentKind,
  permissionConfig,
  planMode,
  disabled,
  onPermissionConfigChange,
  onPlanModeChange,
  onModeChange,
  compact,
  rawPermissionType,
  rawPermissionDescription,
  pendingPermission,
  onPermissionResponse,
  permissionResponsePending,
}: AgentPermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  // 档位、当前选中项与 plan 语义全部来自 module；这里不再自己挑表。
  // 归一化（legacy Codex sandbox 三元组 → workflow tiers）也在 module 内完成。
  const menu = useMemo(
    () => permissionMenu(agentKind, permissionConfig, planMode),
    [agentKind, permissionConfig, planMode],
  );
  // 仍需要归一化后的快照：OpenCode 的盾牌开关要在切档时保留。
  const normalized = useMemo(
    () => serializePermissionConfig(
      agentKind,
      permissionConfig ?? buildDefaultPermissionConfig(agentKind),
    ),
    [agentKind, permissionConfig],
  );
  const options: AgentTier[] = menu.tiers;
  const selected = useMemo(
    () => options.find((option) => option.mode === menu.selectedMode) ?? options[0],
    [options, menu.selectedMode],
  );
  const SelectedIcon = tierIcon(selected.iconName);

  const selectMode = (mode: AgentExecutionMode) => {
    // 配置与 plan 一起算：正交性（Codex）与 via-tier（Claude/OpenCode）都在
    // module 里按规格判断，组件不再按 kind 字符串分支。
    const { config: nextConfig, planMode: nextPlanMode } = applyTier(
      agentKind,
      mode,
      normalized,
      planMode,
    );

    // Prefer the atomic callback to avoid race conditions between
    // separate config and plan-mode state updates.
    if (onModeChange) {
      onModeChange(nextConfig, nextPlanMode);
    } else {
      onPermissionConfigChange(nextConfig);
      // 有 plan 概念的 kind 才回调 plan（pi 没有 plan 档，给它发噪声没有意义）。
      if (menu.planMode !== 'unsupported') {
        onPlanModeChange(nextPlanMode);
      }
    }
    setOpen(false);
  };

  const toggleAutoApprove = () => {
    const nextConfig: AgentPermissionConfig = {
      kind: 'opencode',
      autoApprovePermissions: !(normalized.kind === 'opencode' && normalized.autoApprovePermissions),
    };
    if (onModeChange) {
      onModeChange(nextConfig, planMode);
    } else {
      onPermissionConfigChange(nextConfig);
    }
  };

  return (
    <div>
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2">
          <Popover open={open} onOpenChange={setOpen}>
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
                      COMPOSER_BAR_CONTROL_CLASS,
                      compact ? 'max-w-9 px-0' : 'max-w-none',
                      selected.dangerous &&
                        'text-orange-500 hover:bg-orange-500/10 hover:text-orange-500',
                    )}
                  >
                    <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
                    {!compact && <span>{selected.label}</span>}
                    {!compact && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />}
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{selected.label}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="top"
              sideOffset={8}
              align="start"
              className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1.5 shadow-elevation backdrop-blur-lg"
            >
              {options.map((option) => {
                const active = menu.selectedMode === option.mode;
                const Icon = tierIcon(option.iconName);
                return (
                  <button
                    key={option.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMode(option.mode)}
                    className={cn(
                      // 原来 `hover:bg-muted/56` + `active: 'bg-muted/64'`：浅色主题下
                      // --muted≈98.8% 压在 surface-2 面板上，两个 alpha 都≈纯白，
                      // 选中与悬停读不出差别。改走共享的三档 option-row。
                      'option-row option-row-hover flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left',
                      active && 'option-row-selected',
                    )}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground', option.dangerous && 'text-orange-500')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-compact font-medium text-foreground">{option.label}</span>
                      <span className="block truncate text-ui-caption leading-4 text-muted-foreground">{option.description}</span>
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>

          {agentKind === 'opencode' && (() => {
            const autoApprove = normalized.kind === 'opencode' && normalized.autoApprovePermissions;
            const AutoApproveIcon = autoApprove ? ShieldCheck : Shield;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="opencode-auto-approve-toggle"
                    disabled={disabled}
                    aria-label="自动接受权限"
                    aria-pressed={autoApprove}
                    onClick={toggleAutoApprove}
                    className={cn(
                      COMPOSER_BAR_CONTROL_CLASS,
                      COMPOSER_BAR_ICON_CONTROL_CLASS,
                      autoApprove && 'text-orange-500 hover:bg-orange-500/10 hover:text-orange-500',
                    )}
                  >
                    <AutoApproveIcon className="h-4 w-4 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{autoApprove ? '关闭自动接受权限（恢复逐项确认）' : '自动接受权限请求（显式拒绝的规则仍生效）'}</TooltipContent>
              </Tooltip>
            );
          })()}
        </div>
      </TooltipProvider>

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
