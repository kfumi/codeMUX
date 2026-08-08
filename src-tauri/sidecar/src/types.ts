import type { AgentInputAttachment, AgentInputPayload } from './agentInputPayload.js';
import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import type { TurnTimeouts } from './turnTimeouts.js';

export type RuntimeFlavor = 'claude' | 'codex' | 'opencode';

export type OpenCodeCredentialSource = 'codemux' | 'environment' | 'opencode' | 'none';

export interface SidecarModelLimits {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface OpenCodeSessionConfig {
  cwd: string;
  sessionId: string;
  agentSessionId?: string;
  runtimeGeneration: number;
  provider: string;
  model: string;
  credentialSource: OpenCodeCredentialSource;
  apiKey?: string;
  baseUrl?: string;
  /** 外部托管 Runtime 引用。 */
  runtimeRef?: ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
  modelLimits?: SidecarModelLimits;
}

export interface OpenCodeSessionMapping {
  sessionId: string;
  agentSessionId: string;
  runtimeGeneration: number;
}

export interface RuntimeEventContext {
  agentId: string;
  sessionId: string;
  agentSessionId?: string;
  sequence: number;
  eventIdFactory?: () => string;
}

// Commands from Rust to sidecar (via stdin)
export type SidecarCommand =
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; resumeOnly?: boolean; runtimeGeneration?: number; apiKey?: string; baseUrl?: string; provider?: string; credentialSource?: OpenCodeCredentialSource; model?: string; reasoningEffort?: string; codexNeedsProxy?: boolean; skills?: string[]; settingSources?: string[]; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode; runtimeRef?: ProviderRuntimeRef; timeouts?: TurnTimeouts; modelLimits?: SidecarModelLimits }
  | { type: 'fork_session'; sessionId: string; requestId: string; sourceAgentSessionId?: string; sourceProviderMessageId?: string; sourceProviderTurnId?: string; sourceProviderTurnOrdinal?: number }
  | { type: 'update_permissions'; sessionId?: string; agentKind?: string; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode }
  | { type: 'enrich_attachments'; requestId: string; attachments: AgentInputAttachment[]; protocol: 'anthropic' | 'openai_compatible'; apiKey: string; baseUrl: string; model: string }
  | { type: 'send_input'; sessionId?: string; prompt: string; displayContent?: string; inputPayload?: AgentInputPayload }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string; agentSessionId: string; requestId: string; cwd?: string; runtimeRef: ProviderRuntimeRef }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown }
  | { type: 'respond_to_permission'; requestId: string; sessionId: string; response: unknown }
  | { type: 'start_proxy'; apiKey: string; baseUrl: string; providerName?: string; codexNeedsProxy?: boolean }
  | { type: 'stop_proxy' }
  | { type: 'proxy_status' };

// The sidecar emits raw SDKMessage JSON lines to stdout.
// We re-export key shapes here for reference only.
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}
