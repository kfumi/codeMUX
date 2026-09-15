// 会话标题同步信封：底层 runtime 产生的原生标题（OpenCode session.updated、
// Claude getSessionInfo 的 ai-title、Codex thread name、pi session name）
// 统一投影为一条 `agent_session_title` 控制事件。与 `agent_session_mapping`
// 同类：不进 timeline 领域事件白名单，由 daemon 单独解析后落 sessions.title。
//
// 标题回写底层 runtime 的路径被刻意排除（原生 resume 选择器保持底层自己的
// 命名），这里只做"底层 → CodeMUX"单向同步。

export type AgentSessionTitleAgentKind = 'claude_code' | 'codex' | 'opencode' | 'pi';

export type AgentSessionTitleEvent = {
  type: 'agent_session_title';
  app_session_id: string;
  agent_kind: AgentSessionTitleAgentKind;
  title: string;
  runtime_generation?: number;
};

export function buildSessionTitleEvent(input: {
  appSessionId: string;
  agentKind: AgentSessionTitleAgentKind;
  title: string;
  runtimeGeneration?: number;
}): AgentSessionTitleEvent {
  return {
    type: 'agent_session_title',
    app_session_id: input.appSessionId,
    agent_kind: input.agentKind,
    title: input.title,
    ...(input.runtimeGeneration !== undefined ? { runtime_generation: input.runtimeGeneration } : {}),
  };
}

/**
 * OpenCode 新建/子会话的占位标题（LLM 生成完成前一直保留）。占位值不能覆盖
 * 首条用户消息播种的标题，必须过滤。
 */
export function isOpenCodePlaceholderTitle(title: string): boolean {
  return title.startsWith('New session - ') || title.startsWith('Child session - ');
}

/**
 * Claude SDK `getSessionInfo()` 的 `SDKSessionInfo` 中的可显示标题
 * （custom title → ai-title → first prompt 的兜底链已由 SDK 归一）。
 * 会话不可得或标题为空时返回 undefined。
 */
export function extractClaudeSessionTitle(info: unknown): string | undefined {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const summary = (info as Record<string, unknown>).summary;
  if (typeof summary !== 'string') return undefined;
  const value = summary.trim();
  return value.length > 0 ? value : undefined;
}
