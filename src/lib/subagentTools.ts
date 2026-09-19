/**
 * 委派（子智能体）工具的判定：Claude 的 `Task`、Codex/OpenCode 的 `Agent`/`subagent` 都算。
 *
 * 放在 lib 里是因为两处必须共用同一条口径：
 * - 消息部分渲染：能按 `toolCallId` 找到子智能体描述符时，这一行由委派卡片取代；
 * - 处理段分组（`activityRuns`）：委派事件自成一段，像正文一样把相邻的步骤组隔开，
 *   不能并进「已处理 N 个步骤」那种连续过程组里。
 */
export function isSubagentToolName(toolName: string | null | undefined): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'subagent' || toolName === 'task';
}
