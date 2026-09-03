import type { AppConfig } from '../types/provider';
import type { ScheduledTaskDraft } from '../types/scheduledTask';
import type { AgentKind } from '../types/session';
import { getDefaultAgentKind } from '../types/agentRegistry';
import {
  buildDefaultPermissionConfig,
  serializePermissionConfig,
  type AgentPermissionConfig,
} from './agentPermissions';

export interface AgentModelOption {
  modelId: string;
  providerId: string;
}

export function getDefaultAgentKindFromConfig(config: AppConfig | null): AgentKind {
  return config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
}

export function buildScheduledTaskDraftFromSettings(
  config: AppConfig | null,
  overrides: Partial<ScheduledTaskDraft> = {},
): ScheduledTaskDraft {
  const agentKind = getDefaultAgentKindFromConfig(config);
  const modelDefaults = getConfiguredAgentModelIds(agentKind, config);
  return {
    title: '未命名定时任务',
    instruction: '',
    projectId: null,
    agentKind,
    providerId: modelDefaults.providerId,
    model: modelDefaults.model,
    reasoningEffort: 'high',
    permissionConfig: getAgentPermissionDefault(agentKind, config),
    planMode: 'off',
    enabled: true,
    ...overrides,
  };
}

export function getAgentPermissionDefault(
  agentKind: AgentKind,
  config: AppConfig | null,
): AgentPermissionConfig {
  if (!config) {
    return buildDefaultPermissionConfig(agentKind);
  }
  // pi 无权限配置；联合类型收窄交给调用侧的默认值。
  const agentConfig = config.agent_configs[agentKind] as { permission_config?: unknown } | undefined;
  return serializePermissionConfig(agentKind, agentConfig?.permission_config);
}

function isProviderAgent(agentKind: AgentKind): boolean {
  return (
    agentKind === 'claude_code' ||
    agentKind === 'codex' ||
    agentKind === 'opencode' ||
    agentKind === 'pi'
  );
}

export function getConfiguredAgentModelIds(
  agentKind: AgentKind,
  config: AppConfig | null,
): { providerId: string | null; model: string | null } {
  if (!isProviderAgent(agentKind) || !config) {
    return { providerId: null, model: null };
  }
  const agentConfig = config.agent_configs[agentKind];
  return {
    providerId: agentConfig?.default_provider_id ?? config.active_provider_id ?? null,
    model: agentConfig?.default_model ?? null,
  };
}

export function resolvePreferredAgentModel(
  agentKind: AgentKind,
  config: AppConfig | null,
  models: AgentModelOption[],
  explicitProviderId: string | null,
  explicitModel: string | null,
): AgentModelOption | null {
  if (!isProviderAgent(agentKind)) {
    return null;
  }

  const configured = getConfiguredAgentModelIds(agentKind, config);
  const preferredProviderId = explicitProviderId
    ?? configured.providerId;
  const preferredModelId = explicitModel ?? configured.model;

  if (
    preferredModelId
    && models.some((model) => model.modelId === preferredModelId && (
      !preferredProviderId || model.providerId === preferredProviderId
    ))
  ) {
    return models.find((model) =>
      model.modelId === preferredModelId
      && (!preferredProviderId || model.providerId === preferredProviderId),
    ) ?? null;
  }

  if (preferredProviderId) {
    return models.find((model) => model.providerId === preferredProviderId) ?? models[0] ?? null;
  }

  return models[0] ?? null;
}
