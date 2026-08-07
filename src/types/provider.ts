import type { AgentKind } from './session';
import type { ClaudePermissionConfig, CodexPermissionConfig } from '../lib/agentPermissions';
import type { OpenTarget } from '../lib/openTargets';

export type Theme = 'Light' | 'Dark' | 'System';

export const NOTIFICATION_SOUNDS = ['ding', 'chime', 'bell', 'success'] as const;
export type NotificationSound = typeof NOTIFICATION_SOUNDS[number];
export const DEFAULT_NOTIFICATION_SOUND: NotificationSound = 'ding';

export interface NotificationSettings {
  system_enabled: boolean;
  sound_enabled: boolean;
  sound: NotificationSound;
}

export interface AgentDefaults {
  default_agent_kind: AgentKind;
}

export interface AgentTimeouts {
  idle_timeout_ms?: number;
  approval_timeout_ms?: number;
  question_timeout_ms?: number;
}

export interface AgentConfigMap {
  claude_code: {
    executable_mode?: 'auto' | 'bundled' | 'path';
    resume_sessions?: boolean;
    permission_config?: ClaudePermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
  codex: {
    sdk_mode?: 'responses' | 'agent';
    permission_config?: CodexPermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
  gemini_cli: Record<string, never>;
  opencode: {
    timeouts?: AgentTimeouts | null;
  };
}

export type AgentConfigUpdateMap = {
  claude_code: Partial<AgentConfigMap['claude_code']>;
  codex: Partial<AgentConfigMap['codex']>;
  gemini_cli: Partial<AgentConfigMap['gemini_cli']>;
  opencode: Partial<AgentConfigMap['opencode']>;
};

export type Protocol = 'anthropic' | 'openai_compatible';

export interface ProtocolEndpoint {
  protocol: Protocol;
  base_url: string;
  api_key_override?: string | null;
  codex_needs_proxy?: boolean | null;
}

export interface ProviderModel {
  id: string;
  name?: string | null;
}

export interface ModelProvider {
  id: string;
  name: string;
  enabled: boolean;
  api_key: string;
  endpoints: ProtocolEndpoint[];
  models: ProviderModel[];
  default_model: string;
  builtin_template_id?: string | null;
  opencode_provider_key?: string | null;
  opencode_npm?: string | null;
}

export interface BuiltinProviderTemplate {
  id: string;
  name: string;
  endpoints: ProtocolEndpoint[];
  models: ProviderModel[];
  default_model: string;
  opencode_provider_key?: string | null;
  opencode_npm?: string | null;
  default_codex_needs_proxy?: boolean;
}

/** @deprecated Legacy unified provider; prefer ModelProvider. */
export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
  models?: string[];
  context_1m?: boolean;
  codex_needs_proxy?: boolean;
}

export interface AppConfig {
  model_providers: ModelProvider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap;
  compact_ai_output: boolean;
  default_open_target: OpenTarget;
  notifications: NotificationSettings;
  theme: Theme;
  /** Cleared on load; kept optional for transitional UI code. */
  providers?: Provider[];
  agent_profile_registry?: never;
}
