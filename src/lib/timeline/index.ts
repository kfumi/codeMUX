/**
 * Timeline module: raw frame → parsed AgentMessage → Turn 投影 → 终态判定。
 *
 * 协议知识只在这一层；store 只持有输出，视图只读投影。
 */
export { parseAgentEvent } from './parse';
export {
  buildConversationTurns,
  buildConversationTurnIndex,
  isRealConversationUserEvent,
  type ConversationTurnOptions,
} from './turns';
export {
  isTerminalAgentEvent,
  shouldProcessTerminalEvent,
} from './terminality';
