import type { AgentInputAttachment, AgentInputPayload } from './agentInputPayload.js';
import type { AgentPlanMode, PiApprovalExecutionMode, SidecarPermissionConfig } from './agentPermissions.js';
import type { PiApprovalMode } from './piExtension.js';
import type { PiThinkingLevel } from './piEvents.js';
import type { PiMcpServers } from './piMcp.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import type { TurnTimeouts } from './turnTimeouts.js';

export type RuntimeFlavor = 'claude' | 'codex' | 'opencode' | 'pi';

export type OpenCodeCredentialSource = 'codemux' | 'environment' | 'opencode' | 'none';

export type PiCredentialSource = 'codemux' | 'environment' | 'none';

export interface SidecarModelLimits {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** pi 模型条目的输出 token 上限（models.json `maxTokens`）。 */
  maxTokens?: number;
  inputModalities?: string[];
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
  /** daemon 随会话命令下发的 MCP 服务器(落 server config 的 mcp 段)。 */
  mcpServers?: PiMcpServers;
}

export interface OpenCodeSessionMapping {
  sessionId: string;
  agentSessionId: string;
  runtimeGeneration: number;
}

export interface PiSessionConfig {
  cwd: string;
  sessionId: string;
  /** pi 会话文件绝对路径（Native Session mapping），存在时以 `--session` 恢复。 */
  agentSessionId?: string;
  runtimeGeneration: number;
  provider?: string;
  model?: string;
  /** pi 思考等级（由会话 reasoningEffort 映射，'none' → 'off'）。 */
  thinkingLevel?: PiThinkingLevel;
  credentialSource: PiCredentialSource;
  apiKey?: string;
  baseUrl?: string;
  /**
   * pi 审批档位（映射 CodeMUX execution mode；plan 对 pi 不适用）。变更经
   * canReuse 比对触发 pi 进程重建，与模型/思考等级同机制，下一轮生效。
   */
  approvalMode?: PiApprovalMode;
  /**
   * pi 配置目录（PI_CODING_AGENT_DIR 重定向目标）。codemux 凭据来源下必填：
   * 端点凭据经该目录的 models.json 注入，与用户 ~/.pi 硬隔离（ADR 0005）。
   */
  piConfigDir?: string;
  /** pi models.json 模型条目元数据（来自 CodeMUX ProviderModel）。 */
  modelContextWindow?: number;
  modelMaxTokens?: number;
  /** 外部托管 Runtime 引用。 */
  runtimeRef?: ProviderRuntimeRef;
  /** CodeMUX 为 pi 启用的 MCP 服务器（启动时写入临时 mcp.json 并传 `--mcp-config`）。 */
  mcpServers?: PiMcpServers;
}

export interface PiSessionMapping {
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
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; resumeOnly?: boolean; runtimeGeneration?: number; apiKey?: string; baseUrl?: string; provider?: string; credentialSource?: OpenCodeCredentialSource; model?: string; reasoningEffort?: string; codexNeedsProxy?: boolean; skills?: string[]; settingSources?: string[]; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode; runtimeRef?: ProviderRuntimeRef; timeouts?: TurnTimeouts; modelLimits?: SidecarModelLimits; piConfigDir?: string; mcpServers?: PiMcpServers }
  | { type: 'fork_session'; sessionId: string; requestId: string; sourceAgentSessionId?: string; sourceProviderMessageId?: string; sourceProviderTurnId?: string; sourceProviderTurnOrdinal?: number }
  | { type: 'rewind_files'; sessionId: string; requestId: string; providerMessageId: string }
  | { type: 'rewind_conversation'; sessionId: string; requestId: string; entryId?: string; providerMessageId?: string; providerMessageTurnOrdinal?: number }
  | { type: 'update_permissions'; sessionId?: string; agentKind?: string; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode }
  | { type: 'enrich_attachments'; requestId: string; attachments: AgentInputAttachment[]; protocol: 'anthropic' | 'openai_compatible'; apiKey: string; baseUrl: string; model: string }
  | { type: 'send_input'; sessionId?: string; prompt: string; displayContent?: string; inputPayload?: AgentInputPayload; delivery?: 'steer'; requestId?: string }
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
