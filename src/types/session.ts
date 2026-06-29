export type AgentKind = 'claude_code' | 'codex' | 'gemini_cli' | 'opencode';
export type SessionMode = 'chat' | 'agent';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type AgentPlanMode = 'off' | 'on';

export interface Session {
  id: string;
  title: string;
  agent_kind: AgentKind;
  provider_id: string | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  mode: string | null;
  permission_config: string | null;
  plan_mode: AgentPlanMode | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
}

export interface CreateSessionRequest {
  title: string;
  agent_kind: AgentKind;
  mode?: SessionMode;
  permission_config?: string;
  plan_mode?: AgentPlanMode;
  project_id?: string;
}
