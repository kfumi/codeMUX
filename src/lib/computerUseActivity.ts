/**
 * 电脑控制活动信号(工单 10 跟进):判断智能体是不是**真的在操作桌面**。
 *
 * 只认 daemon 内置 codemux-browser MCP 的 `computer_*` 工具面;`browser_*` 是
 * 内置浏览器里的网页操作(不驱动桌面、不需要 Esc),不在这里的识别范围。
 *
 * 工具名在各智能体下的形态不同,匹配对三种形态都成立:
 *   - Claude / Codex: `mcp__codemux-browser__computer_click`
 *   - OpenCode 等 `server_tool` 形态: `codemux-browser_computer_click`
 *   - daemon 审批帧里的裸名: `computer_click`
 */
import type { AgentMessage } from '../stores/agentStore';
import type { ConversationTurn } from '../types/conversationTurn';

/** daemon 内置 MCP 的桌面工具全名(与 crates/daemon/src/browser_mcp.rs 的工具表同源)。 */
export const COMPUTER_USE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'computer_windows',
  'computer_screenshot',
  'computer_active_window',
  'computer_apps',
  'computer_elements',
  'computer_wait',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_paste',
  'computer_scroll',
  'computer_drag',
  'computer_set_value',
  'computer_launch',
]);

export function isComputerUseToolName(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (COMPUTER_USE_TOOL_NAMES.has(lower)) return true;
  if (lower.startsWith('mcp__')) {
    const segments = lower.split('__');
    const tool = segments[segments.length - 1] ?? '';
    const server = segments.slice(1, -1).join('__');
    return server === 'codemux-browser' && tool.startsWith('computer_');
  }
  return lower.includes('codemux-browser_computer_') || lower.includes('codemux_browser_computer_');
}

/**
 * 回合里有「已发出、结果未回」的 computer_* 工具调用。
 *
 * `pendingToolIds` 是 store 里既有的回合投影(工具调用与结果的配对),这里只把
 * 命中的 id 与工具名对上 —— 审批等待与驱动执行都包含在这段窗口里。
 */
export function turnHasPendingComputerUseCall(
  turn: Pick<ConversationTurn<AgentMessage>, 'pendingToolIds' | 'messages'>,
): boolean {
  if (turn.pendingToolIds.length === 0) return false;
  const pending = new Set(turn.pendingToolIds);
  for (const event of turn.messages) {
    if (event.kind !== 'assistant') continue;
    const content = event.data.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const typed = block as { type?: unknown; id?: unknown; name?: unknown };
      if (
        typed?.type === 'tool_use'
        && typeof typed.id === 'string'
        && pending.has(typed.id)
        && typeof typed.name === 'string'
        && isComputerUseToolName(typed.name)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 回合当前停在「等工具」上:最后一条消息是 assistant(工具刚发出、结果未回)
 * 或 tool_result(并行工具的结果在分批回来)。
 *
 * 用来挡住一种陈旧残留:被中断的旧回合里挂着一个永不回来的 computer 调用,
 * 新消息刚发出、新回合事件还没落地时,只按 pending 判断会误武装(闪一下假提示)。
 */
export function turnIsWaitingOnTool(
  turn: Pick<ConversationTurn<AgentMessage>, 'messages'>,
): boolean {
  const last = turn.messages[turn.messages.length - 1];
  return last?.kind === 'assistant' || last?.kind === 'tool_result';
}

/**
 * 子智能体时间线里有在飞的 computer_* 调用。时间线是原始 `tool_started` /
 * `tool_finished` 帧;同一 `tool_use_id` 的重复 `tool_started` 是输入刷新,
 * 只在 `tool_finished` 时解除。
 */
export function subagentTimelineHasPendingComputerUse(
  timeline: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const pending = new Set<string>();
  for (const event of timeline) {
    const id = event?.tool_use_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (event.type === 'tool_started') {
      const name = event.name;
      if (typeof name === 'string' && isComputerUseToolName(name)) pending.add(id);
    } else if (event.type === 'tool_finished') {
      pending.delete(id);
    }
  }
  return pending.size > 0;
}
