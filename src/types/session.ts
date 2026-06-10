export type AgentKind = 'claude_code' | 'codex' | 'gemini_cli' | 'opencode';

export interface Session {
  id: string;
  title: string;
  agent_kind: AgentKind;
  provider_id: string | null;
  model: string | null;
  mode: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionRequest {
  title: string;
  agent_kind: AgentKind;
  mode?: string;
  project_id?: string;
}
