import { parseAgentEvent, type AgentMessage } from '@/stores/agentStore';

/**
 * 子智能体时间线的**未提交尾部**投影。
 *
 * ## 为什么需要它
 *
 * 主线程的流式正文来自 `agentStore` 的实时缓冲（`streamingText` / `streamingThinking`）：
 * delta 走缓冲、**从不**进 `events[]`，只有完整的 assistant 事件才落库。子智能体走的是
 * 相反的路 —— daemon 为了历史可回放，把每条 delta 都持久化进
 * `session_subagent_events`，于是时间线里 delta 与已提交正文**同时存在**。
 *
 * `convertAgentEventsToAssistantMessages` 只认已提交的那一半（`assistant` /
 * `user` / `tool_result` / `error` …，没有 `streaming` 分支），所以子智能体正文
 * 只在 provider 的 `assistant_message` 信封到达时才整段出现 —— 也就是这条消息结束的
 * 那一刻。这个模块负责把「已提交之前、最后一次提交之后」的那段增量补回来，让正文逐字
 * 出来。
 *
 * ## 判定规则：位置，而不是 index
 *
 * `assistant_message` 信封**不带 index**，所以无法按内容块号把已提交正文与 delta 对上。
 * 改用位置判定：从尾部往前扫，收集连续的 `streaming` 消息，撞到任何非流式消息就停。
 *
 * 这与主线程的口径一致 —— `agentStore` 收到真正的 assistant 事件时清空实时缓冲，
 * 等价于「提交点之后的一切都还没进正文」。因此**尾部为空 ⟺ 文本已被提交**，两者不会
 * 同时显示同一段文字。
 *
 * 顺带一个白送的好处：sidecar 已经把 OpenCode 那种「用 `text_delta` 传推理」的情况
 * 归一成了 `reasoning_delta`（`opencodeEvents.ts` 按 `nextSection` 决定发哪一种），
 * 所以这里不需要主线程那套 `isOpencodeLikeAgent` + 流阶段的启发式。
 *
 * 纯函数：不订阅 store、不读时钟、不排定时器。
 */

/** 尾部保留上限，与主线程实时缓冲的 `STREAMING_PREVIEW_MAX_CHARS` 同口径。 */
export const SUBAGENT_LIVE_TAIL_MAX_CHARS = 16_384;

export type SubagentLiveTail = {
  /** 未提交的思考增量全文。 */
  thinking: string;
  /** 未提交的正文增量全文。 */
  text: string;
  /** 尾部确实还有未提交的流式增量（用于决定是否走分帧绘制）。 */
  streaming: boolean;
};

const EMPTY_TAIL: SubagentLiveTail = { thinking: '', text: '', streaming: false };

/** 是否属于「尚未提交」的那段流式消息（含不含正文都算）。 */
function isStreamingMessage(message: AgentMessage): boolean {
  return message.kind === 'streaming' || message.kind === 'streaming_batch';
}

/** 一条流式消息里的正文增量；结构事件（块的开始/结束）与工具入参返回 undefined。 */
function streamingDelta(message: AgentMessage): { kind: 'thinking' | 'text'; text: string } | undefined {
  if (!isStreamingMessage(message)) {
    return undefined;
  }
  const event = (message as { data?: { event?: Record<string, unknown> } }).data?.event;
  const delta = event?.delta as Record<string, unknown> | undefined;
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return { kind: 'thinking', text: delta.thinking };
  }
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return { kind: 'text', text: delta.text };
  }
  // content_block_start / content_block_stop 只是**同一个在途内容块**的结构标记，
  // 它们不终止尾部扫描（下一个块的 delta 仍属于未提交的一段）；工具入参增量则由
  // `tool_started` 的完整 input 承载（sidecar 对子智能体时间线开了 `refreshToolInput`），
  // 不该进正文尾部。
  return undefined;
}

/** 从尾部保留最近 `maxChars` 个字符。 */
function capTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export function subagentLiveTail(events: readonly AgentMessage[]): SubagentLiveTail {
  // 从尾部往前扫：流式消息属于未提交的一段（正文或结构），撞到任何**已提交**消息即停。
  // `streaming_batch` 一次可含多条 delta，按出现顺序依次展开。
  const collected: Array<{ kind: 'thinking' | 'text'; text: string }> = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const message = events[index];
    if (!isStreamingMessage(message)) {
      break;
    }
    if (message.kind === 'streaming_batch') {
      const batch = (message as { data?: { events?: unknown[] } }).data?.events ?? [];
      for (let inner = batch.length - 1; inner >= 0; inner -= 1) {
        const delta = streamingDelta(parseAgentEvent(batch[inner] as Record<string, unknown>));
        if (delta) collected.push(delta);
      }
      continue;
    }
    const delta = streamingDelta(message);
    if (delta) collected.push(delta);
  }
  if (collected.length === 0) {
    return EMPTY_TAIL;
  }
  collected.reverse();

  let thinking = '';
  let text = '';
  for (const delta of collected) {
    if (delta.kind === 'thinking') {
      thinking = capTail(thinking + delta.text, SUBAGENT_LIVE_TAIL_MAX_CHARS);
    } else {
      text = capTail(text + delta.text, SUBAGENT_LIVE_TAIL_MAX_CHARS);
    }
  }
  // 只有内容块的开始/结束、没有正文时不值得驱动一次绘制。
  if (thinking.length === 0 && text.length === 0) {
    return EMPTY_TAIL;
  }
  return { thinking, text, streaming: true };
}
