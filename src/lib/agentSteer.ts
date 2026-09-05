import { getAgentDefinition } from '../types/agentRegistry';
import type { ImmediateRunMode } from '../types/provider';
import type { AgentKind } from '../types/session';

export function isSteerBlockedPrompt(prompt: string): boolean {
  return prompt.trim().startsWith('/');
}

export function normalizeImmediateRunMode(value: unknown): ImmediateRunMode {
  return value === 'interrupt' ? 'interrupt' : 'steer';
}

export function queuedRunNowHint(
  agentKind?: AgentKind | null,
  mode?: ImmediateRunMode | null,
): string {
  const canSteer = normalizeImmediateRunMode(mode) === 'steer'
    && !!agentKind
    && (getAgentDefinition(agentKind)?.capabilities.includes('supports_steer') ?? false);
  return canSteer
    ? '注入当前轮并立即执行这条消息'
    : '打断当前任务并立即执行这条消息';
}
