// Commands from Rust to sidecar (via stdin)
export type SidecarCommand =
  | { type: 'start'; prompt: string; cwd: string; sessionId?: string; apiKey?: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' };

// The sidecar emits raw SDKMessage JSON lines to stdout.
// We re-export key shapes here for reference only.
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}
