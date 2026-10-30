import type { AppConfig } from '../../../types/provider';
import { ensureDaemonClient } from './lifecycle';

/** 应用配置(daemon config)的读写。 */
export const config = {
  get: async (): Promise<AppConfig> =>
    (await ensureDaemonClient()).getAppConfig() as Promise<AppConfig>,
  setDefaultAgentKind: async (agentKind: import('../../../types/session').AgentKind) => {
    await (await ensureDaemonClient()).patchAppConfig({ defaultAgentKind: agentKind });
  },
  updateAgentConfig: async <T extends keyof import('../../../types/provider').AgentConfigMap>(
    agentKind: T,
    patch: import('../../../types/provider').AgentConfigUpdateMap[T],
  ) => {
    await (await ensureDaemonClient()).patchAppConfig({ agentKind, agentConfig: patch });
  },
  setTheme: async (theme: import('../../../types/provider').Theme) => {
    await (await ensureDaemonClient()).patchAppConfig({ theme: theme.toLowerCase() });
  },
  setCompactAiOutput: async (enabled: boolean) => {
    await (await ensureDaemonClient()).patchAppConfig({ compactAiOutput: enabled });
  },
  setImmediateRunMode: async (mode: import('../../../types/provider').ImmediateRunMode) => {
    await (await ensureDaemonClient()).patchAppConfig({ immediateRunMode: mode });
  },
  setAttachmentEnrichment: async (
    enrichment: import('../../../types/provider').ImageRecognitionConfig,
  ) => {
    await (await ensureDaemonClient()).patchAppConfig({ attachmentEnrichment: enrichment });
  },
  setNotificationSettings: async (
    settings: import('../../../types/provider').NotificationSettings,
  ) => {
    await (await ensureDaemonClient()).patchAppConfig({ notifications: settings });
  },
  setGitSettings: async (settings: import('../../../types/provider').GitSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ git: settings });
  },
  setKeybindings: async (keybindings: import('../../../types/provider').KeybindingsSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ keybindings });
  },
  setDefaultOpenTarget: async (target: import('../../openTargets').OpenTarget) => {
    await (await ensureDaemonClient()).patchAppConfig({ defaultOpenTarget: target });
  },
  setBrowserControl: async (
    settings: import('../../../types/provider').BrowserControlSettings,
  ) => {
    await (await ensureDaemonClient()).patchAppConfig({ browser: settings });
  },
  setComputerUse: async (settings: import('../../../types/provider').ComputerUseSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ computerUse: settings });
  },
};

export type ConfigDomain = typeof config;
