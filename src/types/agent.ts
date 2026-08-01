/** Mode for a session */
export type SessionMode = 'chat' | 'agent';

/** Minimal representation of an SDKMessage from the sidecar */
export type AgentPermissionResponse = 'once' | 'always' | 'reject';

export interface AgentPermissionRequest {
  request_id: string;
  permission_id?: string;
  permission_type: string;
  description: string;
  metadata?: Record<string, unknown>;
}
export interface AgentEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

/** Parsed assistant content block */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Locator for mapping visible UI user messages back to provider history rows. */
export interface AgentUserMessageLocator {
  providerMessageId?: string;
  sourceEventIndex?: number;
  lineIndex?: number;
  role?: 'user';
  textFingerprint?: string;
  turnOrdinal?: number;
}

/** Parsed assistant message */
export interface AgentAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  supersedes?: string[];
  message: {
    role: 'assistant';
    content: ContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string | null;
    model?: string;
  };
  parent_tool_use_id: string | null;
}

/** Tool result from user message */
export interface AgentToolResult {
  type: 'user';
  uuid: string;
  session_id: string;
  message: {
    role: 'user';
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
  };
  parent_tool_use_id: string | null;
}

/** System init message */
export interface AgentSystemMessage {
  type: 'system';
  subtype: 'init';
  uuid: string;
  session_id: string;
  tools: string[];
  model: string;
  cwd: string;
  permissionMode: string;
  mcp_servers?: Array<{ name: string; status: string }>;
}

/** Final result message */
export interface AgentResultMessage {
  type: 'result';
  subtype: 'success' | string;
  is_error: boolean;
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  last_token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
    total_tokens: number;
  };
  terminal_reason?: string;
  /** Set only for read-time compatibility results synthesized from history. */
  synthetic?: boolean;
}

/** Todo item from TodoWrite or Task tools */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Sidecar lifecycle events */
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}

export interface SessionResumeFailedEvent {
  type: 'session_resume_failed';
  session_id?: string;
  agent_kind?: string;
  agent_session_id?: string;
  error: string;
}

export interface SidecarQueryDoneEvent {
  type: 'sidecar_query_done';
}

/** Changed file tracked by Write/Edit tools */
export interface ChangedFile {
  path: string;
  isNew: boolean;
  originalContent?: string;
  currentContent: string;
  additions: number;
  deletions: number;
  _pendingEdits?: Array<{ oldString: string; newString: string }>;
}
