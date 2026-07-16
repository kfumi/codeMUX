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

export interface AgentConfigMap {
  claude_code: {
    executable_mode?: 'auto' | 'bundled' | 'path';
    resume_sessions?: boolean;
    permission_config?: ClaudePermissionConfig;
  };
  codex: {
    sdk_mode?: 'responses' | 'agent';
    permission_config?: CodexPermissionConfig;
  };
  gemini_cli: Record<string, never>;
  opencode: Record<string, never>;
}

export type AgentConfigUpdateMap = {
  claude_code: Partial<AgentConfigMap['claude_code']>;
  codex: Partial<AgentConfigMap['codex']>;
  gemini_cli: Partial<AgentConfigMap['gemini_cli']>;
  opencode: Partial<AgentConfigMap['opencode']>;
};

export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
  /** Available models for this provider. The first entry is the default model. */
  models?: string[];
  /** 1M 上下文窗口（模型名会追加 [1m]） */
  context_1m?: boolean;
  /** Whether Codex should route this provider through the local chat-compat proxy. */
  codex_needs_proxy?: boolean;
}

export interface ProfileModel {
  id: string;
  name?: string | null;
  context_window?: number | null;
}

export interface CodexCatalogModel {
  model: string;
  displayName?: string;
  contextWindow?: number;
}

export interface OpenCodeModel {
  name?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export type NativeProfileConfig =
  | {
      type: 'claude_code';
      settings: Record<string, unknown>;
      requires_review?: boolean;
    }
  | {
      type: 'codex';
      api_key: string;
      openai_base_url: string;
      codex_needs_proxy?: boolean | null;
      advanced_config?: unknown | null;
      auth_json?: string | null;
      config_toml?: string | null;
      model_catalog?: string | null;
      requires_review?: boolean;
    }
  | {
      type: 'opencode';
      api_key: string;
      openai_base_url: string;
      provider_key?: string | null;
      npm?: string | null;
      models_config?: Record<string, OpenCodeModel> | null;
      extra_options?: Record<string, string> | null;
      advanced_config?: unknown | null;
      requires_review?: boolean;
    };

export interface AgentProviderProfile {
  id: string;
  agent_kind: Extract<AgentKind, 'claude_code' | 'codex' | 'opencode'>;
  name: string;
  note: string;
  models: ProfileModel[];
  default_model: string;
  native_config: NativeProfileConfig;
}

export interface AgentProfileRegistry {
  profiles: AgentProviderProfile[];
  active_profile_ids: Partial<Record<AgentProviderProfile['agent_kind'], string>>;
}

export type AgentProviderProfileUpsert = Omit<AgentProviderProfile, 'native_config'> & {
  native_config:
    | { type: 'claude_code'; settings: Record<string, unknown>; requires_review?: boolean }
    | { type: 'codex'; api_key?: string; openai_base_url: string; codex_needs_proxy?: boolean | null; advanced_config?: unknown; auth_json?: string | null; config_toml?: string | null; model_catalog?: CodexCatalogModel[] | null; requires_review?: boolean }
    | { type: 'opencode'; api_key?: string; openai_base_url: string; provider_key?: string; npm?: string; models_config?: Record<string, OpenCodeModel> | null; extra_options?: Record<string, string> | null; advanced_config?: unknown; requires_review?: boolean };
};

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap;
  compact_ai_output: boolean;
  default_open_target: OpenTarget;
  notifications: NotificationSettings;
  theme: Theme;
  agent_profile_registry?: AgentProfileRegistry;
}
