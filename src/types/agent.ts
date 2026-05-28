/** Mode for a session */
export type SessionMode = 'chat' | 'agent';

/** Minimal representation of an SDKMessage from the sidecar */
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

/** Parsed assistant message */
export interface AgentAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    role: 'assistant';
    content: ContentBlock[];
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
}

/** Final result message */
export interface AgentResultMessage {
  type: 'result';
  subtype: 'success' | string;
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  terminal_reason?: string;
}

/** Sidecar lifecycle events */
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}

export interface SidecarQueryDoneEvent {
  type: 'sidecar_query_done';
}
