export type AgentKind = 'claude_code' | 'codex' | 'gemini_cli' | 'opencode' | 'pi';
export type SessionMode = 'chat' | 'agent';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** Effective agent cwd; set for worktree sessions. */
  working_path?: string | null;
  /** 工作路径建立时所在的分支；悬停卡片直接读它，缺省（历史会话）才实时查询。 */
  git_branch?: string | null;
  /** `native` sessions are managed by CodeMUX; imported sessions are snapshots. */
  origin?: 'native' | 'imported' | 'scheduled';
  is_read_only?: boolean;
  created_at: string;
  updated_at: string;
  parent_session_id?: string | null;
  is_archived: boolean;
  is_pinned: boolean;
}

export interface CreateSessionRequest {
  title: string;
  agent_kind: AgentKind;
  mode?: SessionMode;
  permission_config?: string;
  plan_mode?: AgentPlanMode;
  project_id?: string;
}
