import type { AgentKind, ReasoningEffort } from './session';
import type { ClaudePermissionConfig, CodexPermissionConfig, OpenCodePermissionConfig, PiPermissionConfig } from '../lib/agentPermissions';
import type { OpenTarget } from '../lib/openTargets';

export type Theme = 'Light' | 'Dark' | 'System';
export type ImmediateRunMode = 'steer' | 'interrupt';

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
    default_provider_id?: string | null;
    default_model?: string;
    permission_config?: ClaudePermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
  codex: {
    default_provider_id?: string | null;
    default_model?: string;
    permission_config?: CodexPermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
  gemini_cli: Record<string, never>;
  opencode: {
    default_provider_id?: string | null;
    default_model?: string;
    permission_config?: OpenCodePermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
  pi: {
    default_provider_id?: string | null;
    default_model?: string;
    permission_config?: PiPermissionConfig;
    timeouts?: AgentTimeouts | null;
  };
}

export type AgentConfigUpdateMap = {
  claude_code: Partial<AgentConfigMap['claude_code']>;
  codex: Partial<AgentConfigMap['codex']>;
  gemini_cli: Partial<AgentConfigMap['gemini_cli']>;
  opencode: Partial<AgentConfigMap['opencode']>;
  pi: Partial<AgentConfigMap['pi']>;
};

export type Protocol = 'anthropic' | 'openai_compatible' | 'openai_responses';

export type InputModality = 'text' | 'image' | 'audio' | 'video';

export interface ProtocolEndpoint {
  protocol: Protocol;
  base_url: string;
  api_key_override?: string | null;
  codex_needs_proxy?: boolean | null;
}

export interface ProviderModel {
  id: string;
  name?: string | null;
  /** Claude Code：通过模型 ID 追加 `[1m]` 启用 1M 上下文；仅 anthropic 端点时有意义。 */
  context_1m?: boolean | null;
  /** Codex / OpenCode 上下文窗口（token）；仅 openai_compatible 端点时有意义。 */
  context_window?: number | null;
  /** OpenCode `limit.input`；仅 openai_compatible 端点时有意义。 */
  max_input_tokens?: number | null;
  /** OpenCode `limit.output`；仅 openai_compatible 端点时有意义。 */
  max_output_tokens?: number | null;
  /** 输入模态；始终包含 text，可额外选择 image / audio / video。 */
  input_modalities?: InputModality[] | null;
  /** @deprecated 由 input_modalities 是否包含 image 推导。 */
  supports_vision?: boolean | null;
  /**
   * 思考档位白名单（`ReasoningEffort` 词表，见 `src/lib/reasoningEffort.ts`）。
   *
   * - `undefined` / `null` = 未声明（目录未命中且用户未配置）
   * - `[]` = 用户明确声明不支持
   * - 非空 = 支持，且精确列出开放哪几档
   *
   * 这是 pi 声明 `reasoning` 的唯一依据：未声明时 pi 会把任何思考档位钳回 off。
   */
  thinking_levels?: ReasoningEffort[] | null;
  /** @deprecated 已被 `thinking_levels` 取代，仅为读取旧配置保留。 */
  supports_reasoning?: boolean | null;
}

export interface ImageRecognitionConfig {
  enabled: boolean;
  api_key: string;
  api_key_configured?: boolean;
  base_url: string;
  model: string;
}

/** @deprecated 使用 ImageRecognitionConfig */
export type AttachmentEnrichmentConfig = ImageRecognitionConfig;

export const DEFAULT_IMAGE_RECOGNITION_CONFIG: ImageRecognitionConfig = {
  enabled: false,
  api_key: '',
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  model: '',
};

/** @deprecated */
export const DEFAULT_ATTACHMENT_ENRICHMENT_CONFIG = DEFAULT_IMAGE_RECOGNITION_CONFIG;

export interface GitSettings {
  commit_instructions: string;
  pull_request_instructions: string;
  provider_id?: string | null;
  model: string;
}

/** Shortcut id → keybinding string; `null` means the shortcut is explicitly unbound. */
export type KeybindingsSettings = Record<string, string | null>;

export interface ModelProvider {
  id: string;
  name: string;
  enabled: boolean;
  api_key: string;
  /** True when backend has a key but redacted it from `api_key`. */
  api_key_configured?: boolean;
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

export interface BrowserControlSettings {
  enabled: boolean;
  ignore_certificate_errors: boolean;
}

export interface AppConfig {
  model_providers: ModelProvider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap;
  compact_ai_output: boolean;
  /** Queue “立即” when the agent can steer: inject into the current turn, or interrupt. */
  immediate_run_mode?: ImmediateRunMode;
  default_open_target: OpenTarget;
  notifications: NotificationSettings;
  git?: GitSettings;
  keybindings?: KeybindingsSettings;
  browser?: BrowserControlSettings;
  theme: Theme;
  attachment_enrichment?: AttachmentEnrichmentConfig;
  /** Cleared on load; kept optional for transitional UI code. */
  providers?: Provider[];
  agent_profile_registry?: never;
}
