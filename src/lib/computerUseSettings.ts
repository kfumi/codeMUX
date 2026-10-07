import type { ComputerUseSettings } from '../types/provider';

export type { ComputerUseSettings };

/** 步数上限的合法区间(与 daemon 侧校验一致)。 */
export const COMPUTER_USE_MIN_STEPS = 1;
export const COMPUTER_USE_MAX_STEPS = 200;

export function normalizeComputerUse(
  value?: Partial<ComputerUseSettings> | null,
): ComputerUseSettings {
  return {
    enabled: value?.enabled ?? false,
    system_execution_enabled: value?.system_execution_enabled ?? false,
    allowlist: Array.isArray(value?.allowlist) ? value!.allowlist!.filter((entry) => typeof entry === 'string') : [],
    max_steps: clampMaxSteps(value?.max_steps),
    driver_command: value?.driver_command ?? null,
    driver_args: Array.isArray(value?.driver_args) ? value!.driver_args!.filter((entry) => typeof entry === 'string') : [],
    driver_update_command: value?.driver_update_command ?? null,
  };
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
