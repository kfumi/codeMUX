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

function normalizeTitleForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Minimum overlap before a truncated summary counts as the first prompt.
 * Shorter matches are too likely to be coincidence (e.g. "fix bug").
 */
const MIN_FIRST_PROMPT_PREFIX_LENGTH = 8;

/**
 * `summary` 是否只是 first prompt 的兜底值。
 *
 * SDK 的 `summary` 链是 custom title → ai-title → first prompt，但 **ai-title
 * 由 CLI 在 `result` 之后才异步写进 transcript**。同步过早时读到的 `summary`
 * 就是 first prompt —— 它不是原生标题，发出去既不会改变 UI（渲染层已用首条
 * 消息播种同一个值），又会把 `claudeTitleSynced` 置真，导致稍后落盘的 ai-title
 * 永远不再被读取（会话 28e26094/705dcfc7 的实际表现）。所以必须识别并跳过。
 */
export function isClaudeFirstPromptFallback(
  summary: string,
  firstPrompt: string | undefined,
): boolean {
  if (!firstPrompt) return false;
  const a = normalizeTitleForCompare(summary);
  const b = normalizeTitleForCompare(firstPrompt);
  if (!a || !b) return false;
  if (a === b) return true;
  // SDK 会把 first prompt 截断后再作为 summary 暴露，前缀匹配即视为兜底值。
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= MIN_FIRST_PROMPT_PREFIX_LENGTH && longer.startsWith(shorter);
}

/**
 * Claude SDK `getSessionInfo()` 的 `SDKSessionInfo` 中的原生标题。
 *
 * 优先 custom title（用户在 CLI 里 /rename 的值），其次 `summary`；`summary`
 * 若仍是 first prompt 兜底值则返回 undefined（表示 ai-title 尚未生成，调用方
 * 应稍后重试，而不是把首条消息当成标题同步）。会话不可得或标题为空时返回
 * undefined。
 */
export function extractClaudeSessionTitle(info: unknown): string | undefined {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const record = info as Record<string, unknown>;
  const customTitle = typeof record.customTitle === 'string' ? record.customTitle.trim() : '';
  if (customTitle) return customTitle;
  const summary = record.summary;
  if (typeof summary !== 'string') return undefined;
  const value = summary.trim();
  if (!value) return undefined;
  const firstPrompt = typeof record.firstPrompt === 'string' ? record.firstPrompt : undefined;
  if (isClaudeFirstPromptFallback(value, firstPrompt)) return undefined;
  return value;
}
