export type AgentKind = 'claude_code' | 'codex' | 'gemini_cli' | 'opencode';
export type SessionMode = 'chat' | 'agent';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface Session {
  id: string;
  title: string;
  agent_kind: AgentKind;
  provider_id: string | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  mode: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionRequest {
  title: string;
  agent_kind: AgentKind;
  mode?: SessionMode;
  project_id?: string;
}
