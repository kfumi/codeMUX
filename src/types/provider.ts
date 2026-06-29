import type { AgentKind } from './session';
import type { ClaudePermissionConfig, CodexPermissionConfig } from '../lib/agentPermissions';

export type Theme = 'Light' | 'Dark' | 'System';

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
  /** 输入 token 单价 ($/1M tokens) */
  input_price?: number;
  /** 缓存命中 token 单价 ($/1M tokens) */
  cache_read_price?: number;
  /** 输出 token 单价 ($/1M tokens) */
  output_price?: number;
  /** 1M 上下文窗口（模型名会追加 [1m]） */
  context_1m?: boolean;
  /** Whether Codex should route this provider through the local chat-compat proxy. */
  codex_needs_proxy?: boolean;
}

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap;
  compact_ai_output: boolean;
  theme: Theme;
}
