import type { AgentMessage } from '@/stores/agentStore';

/**
 * 实时缓冲的**可见性**判定：主线程的 `StreamingContent` 与过程组的活动组头共用同一份。
 *
 * 实时思考住在 `agentStore` 的流式缓冲里（delta 不进事件序列），实时正文同理；判定「这段
 * 缓冲该不该显示、显示成思考还是正文」要对着事件序列做几组去重：
 *
 * - OpenCode 一回合会产出多段「思考 → 正文」。实时思考流开始于最近一次 thinking 提交之后
 *   → 是下一段的新思考，必须显示；流开始后时间线里又提交了 thinking → 缓冲区只是已提交
 *   内容的残留副本，让位给时间线气泡。
 * - 误路由到文本缓冲的思考不能显示成正文；与最近助手正文前缀重叠的文本是重复投影。
 */

export type LiveStreamBuffers = {
  /** 流式思考缓冲原文。 */
  thinking: string;
  /** 流式正文缓冲原文（可能是误路由的思考）。 */
  text: string;
  /** 当前思考流开始时的事件数：与最近一次已提交 thinking 事件比较，识别残留副本。 */
  thinkingEpoch: number;
  /** 用户急停：实时内容整体让位（终态由调用方各自的空态规则兜底）。 */
  stopped: boolean;
};

export type LiveStreamContent = {
  /** 应显示为实时思考的文本（空串表示不显示）。 */
  visibleThinking: string;
  /** 应显示为实时正文的文本（空串表示不显示）。 */
  visibleText: string;
};

function getLastAssistantText(events: AgentMessage[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'assistant') {
      continue;
    }

    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } =>
        block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) {
      return text;
    }
  }

  return '';
}

function getLastAssistantThinking(events: AgentMessage[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'assistant') {
      continue;
    }

    const thinking = event.data.message.content
      .filter((block): block is { type: 'thinking'; thinking: string } =>
        block?.type === 'thinking' && typeof block.thinking === 'string',
      )
      .map((block) => block.thinking)
      .join('')
      .trim();
    if (thinking) {
      return thinking;
    }
  }

  return '';
}

/** 最新一条带非空 thinking 的 assistant 事件下标（没有则 -1）。 */
function getLastCommittedThinkingEventIndex(events: AgentMessage[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'assistant') {
      continue;
    }
    const hasThinking = event.data.message.content.some((block) => (
      isRecord(block)
      && block.type === 'thinking'
      && typeof block.thinking === 'string'
      && block.thinking.length > 0
    ));
    if (hasThinking) {
      return index;
    }
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveLiveStreamContent(
  events: AgentMessage[],
  buffers: LiveStreamBuffers,
): LiveStreamContent {
  const { thinking, text, thinkingEpoch } = buffers;
  const lastAssistantText = getLastAssistantText(events);
  const lastAssistantThinking = getLastAssistantThinking(events);
  const lastCommittedThinkingIndex = getLastCommittedThinkingEventIndex(events);

  const duplicateLiveText = Boolean(
    text
    && lastAssistantText
    && (
      text === lastAssistantText
      || text.startsWith(lastAssistantText)
      || lastAssistantText.startsWith(text)
    ),
  );
  // If text is actually a mis-routed thinking stream, keep it out of the markdown area.
  const textIsMisroutedThinking = Boolean(
    text
    && (
      (thinking && (thinking.startsWith(text) || text.startsWith(thinking) || thinking.includes(text)))
      || (lastAssistantThinking && (
        lastAssistantThinking === text
        || lastAssistantThinking.startsWith(text)
        || text.startsWith(lastAssistantThinking)
      ))
    ),
  );
  const liveThinkingIsStaleCopy = lastCommittedThinkingIndex >= thinkingEpoch;
  const visibleThinking = liveThinkingIsStaleCopy
    ? ''
    : (thinking || (textIsMisroutedThinking ? text : ''));
  const visibleText = (
    duplicateLiveText
    || textIsMisroutedThinking
  ) ? '' : text;

  return { visibleThinking, visibleText };
}
