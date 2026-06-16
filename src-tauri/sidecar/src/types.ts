// Commands from Rust to sidecar (via stdin)
export type SidecarCommand =
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; apiKey?: string; baseUrl?: string; model?: string; skills?: string[] }
  | { type: 'send_input'; prompt: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown }
  | { type: 'start_proxy'; apiKey: string; baseUrl: string }
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
