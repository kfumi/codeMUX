/**
 * 电脑控制活动信号(工单 10 及其跟进):判断智能体是不是**真的在操作桌面**。
 *
 * 只认 daemon 内置 `codemux-control` MCP 的 `computer_*` 工具面;`browser_*` 是
 * 内置浏览器里的网页操作(不驱动桌面、不需要 Esc),不在这里的识别范围。
 *
 * 工具名在各智能体下的形态不同,三种都要认(server 段取 `builtin_mcp::SERVER_NAME`,
 * 外加改名前的 `codemux-browser` —— 历史轨迹里存的是旧全名,见工单 16):
 *   - Claude / Codex: `mcp__codemux-control__computer_click`
 *   - OpenCode 等 `server_tool` 形态: `codemux-control_computer_click`
 *   - daemon 审批帧里的裸名: `computer_click`
 *
 * 判据口径(工单 15):**这个回合里出现过 computer_* 调用**就算在操作桌面,不看
 * 结果是否已经回来。按「工具在飞」判定会让模型两次调用之间的思考空档(数秒到
 * 数十秒)把提示条与全局 Esc 闪断 —— 而提示条要覆盖的是整个操作过程,从第一个
 * 桌面动作到这次回合结束。
 */
import type { AgentMessage } from '../stores/agentStore';
import type { ConversationTurn } from '../types/conversationTurn';
import { builtinMcpToolSegment, DESKTOP_TOOL_PREFIX } from './builtinMcp';

/** daemon 内置 MCP 的桌面工具全名(与 crates/daemon/src/builtin_mcp.rs 的工具表同源)。 */
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
  'computer_save_screenshot',
]);

export function isComputerUseToolName(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (COMPUTER_USE_TOOL_NAMES.has(lower)) return true;

  // server 段(现名与历史名、两种拼写)由 builtinMcp 统一认;这里只关心工具是不是
  // 桌面那一族 —— `browser_*` 是内置浏览器里的网页操作,不驱动桌面、不需要 Esc。
  return builtinMcpToolSegment(lower)?.startsWith(DESKTOP_TOOL_PREFIX) ?? false;
}

/**
 * 回合里出现过 computer_* 工具调用(结果是否回来都算)。
 *
 * 提示条/急停要跟着「这一次桌面操作过程」走:模型在两次调用之间思考时工具已经
 * 回来,但操作没有结束,所以这里按「本回合出现过」判定,回合结束由调用方(会话
 * 是否还在跑)负责解除。
 */
export function turnHasComputerUseCall(
  turn: Pick<ConversationTurn<AgentMessage>, 'messages'>,
): boolean {
  for (const event of turn.messages) {
    if (event.kind !== 'assistant') continue;
    const content = event.data.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const typed = block as { type?: unknown; name?: unknown };
      if (
        typed?.type === 'tool_use'
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
 * 子智能体时间线里出现过 computer_* 调用(同样的「出现过」口径)。时间线是原始
 * `tool_started` / `tool_finished` 帧;调用方要求子智能体仍在跑,跑完即解除。
 */
export function subagentTimelineHasComputerUse(
  timeline: ReadonlyArray<Record<string, unknown>>,
): boolean {
  for (const event of timeline) {
    if (event?.type !== 'tool_started') continue;
    const id = event.tool_use_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const name = event.name;
    if (typeof name === 'string' && isComputerUseToolName(name)) return true;
  }
  return false;
}
