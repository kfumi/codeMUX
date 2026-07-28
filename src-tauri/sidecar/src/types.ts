import type { AgentInputPayload } from './agentInputPayload.js';
import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';

export type RuntimeFlavor = 'claude' | 'codex' | 'opencode';

export type OpenCodeCredentialSource = 'codemux' | 'environment' | 'opencode' | 'none';

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
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; runtimeGeneration?: number; apiKey?: string; baseUrl?: string; provider?: string; credentialSource?: OpenCodeCredentialSource; model?: string; reasoningEffort?: string; codexNeedsProxy?: boolean; skills?: string[]; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode }
  | { type: 'update_permissions'; sessionId?: string; agentKind?: string; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode }
  | { type: 'send_input'; sessionId?: string; prompt: string; displayContent?: string; inputPayload?: AgentInputPayload }
  | { type: 'reset_session'; sessionId: string }
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
