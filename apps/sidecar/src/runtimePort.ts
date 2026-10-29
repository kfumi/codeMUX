import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import type { EnsureSessionCommand, UpdatePermissionsCommand } from './types.js';

/**
 * sidecar 侧四家运行时的统一端口。
 *
 * 目前在 `index.ts` 内保持原样，仅先搬到这里：`claudeRuntime`、`codexAppServerRuntime`
 * 与 OpenCode / pi 的适配器都以它为准。可选方法表示「这一家没有这个能力」，
 * 调用点用 optional-call 判定，而不是按 flavor 分支。
 */
export type SidecarRuntime = {
  ensure(cmd: EnsureSessionCommand): Promise<void>;
  canReuse?(cmd: EnsureSessionCommand): boolean;
  emitSessionMapping?(cmd: EnsureSessionCommand): void;
  updatePermissions(cmd: UpdatePermissionsCommand): void | Promise<void>;
  sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  steerActiveTurn?(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  forkSession?(
    sourceAgentSessionId?: string,
    sourceProviderTurnId?: string,
    sourceProviderTurnOrdinal?: number,
    sourceProviderMessageId?: string,
  ): Promise<string>;
  rewindFiles?(providerMessageId: string): Promise<string[]>;
  /**
   * 会话内回退(回退到目标用户消息之前),provider 原生语义执行:
   * opencode=revert 标记 / claude=SDK fork / codex=thread fork / pi=树 fork。
   * 返回(可能 fork 出的)原生会话 id,daemon 据此更新 mapping。
   * 入参按种类二选一:pi 用 entryId;opencode/claude 用 providerMessageId
   * (claude 为「保留到它之前」的 upTo uuid);codex 用 1-based 用户回合序号。
   */
  rewindConversation?(input: {
    entryId?: string;
    providerMessageId?: string;
    providerMessageTurnOrdinal?: number;
  }): Promise<string>;
  resetSession(sessionId: string): Promise<void>;
  deleteSession?(agentSessionId: string): Promise<void>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  respondToPermission?(requestId: string, response: OpenCodePermissionResponse, sessionId: string): Promise<void>;
  respondToQuestion?(requestId: string, answers: string[][]): Promise<void>;
  isPendingQuestion?(requestId: string): boolean;
};
