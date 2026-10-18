import type { ComputerUseApprovalMode, ComputerUseSettings } from '../types/provider';

export type { ComputerUseApprovalMode, ComputerUseSettings };

/** 步数上限的合法区间(与 daemon 侧校验一致)。 */
export const COMPUTER_USE_MIN_STEPS = 1;
export const COMPUTER_USE_MAX_STEPS = 200;

/** 审批口径选项:值 + 一句话说明(≤40 字,讲它做什么)。 */
export const COMPUTER_USE_APPROVAL_MODES: ReadonlyArray<{
  value: ComputerUseApprovalMode;
  label: string;
  description: string;
}> = [
  {
    value: 'strict',
    label: '逐次确认',
    description: '每一步输入动作都询问;只读可本会话记住',
  },
  {
    value: 'session',
    label: '本会话记住',
    description: '非敏感输入首次确认后本会话不再问;只读免问',
  },
  {
    value: 'always',
    label: '持久放行',
    description: '非敏感输入不再询问;敏感场景仍逐步确认',
  },
];

export function normalizeComputerUse(
  value?: Partial<ComputerUseSettings> | null,
): ComputerUseSettings {
  return {
    enabled: value?.enabled ?? false,
    system_execution_enabled: value?.system_execution_enabled ?? false,
    allowlist: Array.isArray(value?.allowlist) ? value!.allowlist!.filter((entry) => typeof entry === 'string') : [],
    approval_mode: normalizeApprovalMode(value?.approval_mode),
    max_steps: clampMaxSteps(value?.max_steps),
    driver_command: value?.driver_command ?? null,
    driver_args: Array.isArray(value?.driver_args) ? value!.driver_args!.filter((entry) => typeof entry === 'string') : [],
    driver_update_command: value?.driver_update_command ?? null,
  };
}

/** 未知/缺省一律回落到最严格的档位(不能因为字段缺失而放宽)。 */
function normalizeApprovalMode(value?: string | null): ComputerUseApprovalMode {
  return value === 'session' || value === 'always' ? value : 'strict';
}

function clampMaxSteps(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 40;
  const rounded = Math.round(value);
  if (rounded < COMPUTER_USE_MIN_STEPS) return COMPUTER_USE_MIN_STEPS;
  if (rounded > COMPUTER_USE_MAX_STEPS) return COMPUTER_USE_MAX_STEPS;
  return rounded;
}

/** 允许列表输入框 ↔ 数组(逐行一个应用名,忽略空行)。 */
export function parseAllowlistInput(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 100);
}

export function formatAllowlistInput(allowlist: string[] | undefined): string {
  return (allowlist ?? []).join('\n');
}
