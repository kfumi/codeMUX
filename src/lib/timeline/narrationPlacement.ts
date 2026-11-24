import type { AgentMessage } from '../../stores/agentStore';

/**
 * 叙述（narration）事件的**放置规则**——单一真源。
 *
 * ## 为什么单独成模块
 *
 * 这些规则原来内联在 `agentStore` 的 assistant 事件分支里，与 store 的其它副作用
 * 混在一起：想给「晚到的最终答复该放哪」加一条约束，必须先读懂整条事件处理链。
 * 更糟的是它**没有测试边界**——只有把整轮事件喂进 store 才能观察结果，而 store 里
 * 还有很多无关的时序（模拟流式、水位线、回合收尾）会干扰观察。
 *
 * 这里的每个函数都是纯函数：输入事件数组 + 待放置事件，输出新的事件数组。
 *
 * ## 要解决的真实故障
 *
 * 复现（2026-11-24 的长回合）：工具跑完后，最终答复（text-only assistant 事件）
 * 到达时，只要时间线上最后一条仍是 tool-only 事件，旧规则就会把它**插到那些工具
 * 之前**——哪怕那些工具是**本轮更早**执行的、并且**已经完成**。
 *
 * 结果是最终答复被顶到回合中部（用户看到的"答案"出现在自己那段工作之前），
 * 而随后到达的 `turn_finished` 又让它看起来已经收尾——与 daemon 侧的正常收尾
 * 叠加后，界面就停在了一帧错位的画面上，只有切换会话（重拉时间线）才能修正。
 *
 * 旧规则本身是对的，但它的**适用范围**过宽：它想修的是 OpenCode/pi 的
 * 「流式叙述在工具事件之后才 finalize」——那时被插入的文字**属于同一个工具之前**。
 * 判据应该是「这段文字是不是本轮的最终答复」，而不是「时间线末尾是不是工具」。
 */

/** 纯文本 assistant 事件（全部块都是非空 text）。 */
export function isNarrationOnlyAssistantEvent(
  event: AgentMessage,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block: { type?: string; text?: string }) => (
    block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  ));
}

/** 只含工具调用的 assistant 事件。 */
export function isToolOnlyAssistantEvent(
  event: AgentMessage | undefined,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event?.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block: { type?: string }) => block?.type === 'tool_use');
}

/** 同时含 thinking 与 text、无工具块的最终消息（pi 把思考与回答合成一条）。 */
export function isNarrationContinuationAssistantEvent(
  event: AgentMessage,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  let hasText = false;
  let hasThinking = false;
  const allAllowed = content.every((block: { type?: string; text?: string; thinking?: string }) => {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      hasText = true;
      return true;
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
      hasThinking = true;
      return true;
    }
    return false;
  });
  return allAllowed && hasText && hasThinking;
}

/** 取出纯文本叙述事件的正文。 */
export function textFromNarrationOnlyAssistantEvent(event: AgentMessage): string | undefined {
  if (!isNarrationOnlyAssistantEvent(event)) {
    return undefined;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text : ''))
    .join('');
  return text.trim().length > 0 ? text : undefined;
}

/** 取出「思考+正文」最终消息的正文。 */
export function narrationTextFromAssistantEvent(event: AgentMessage): string | undefined {
  if (!isNarrationContinuationAssistantEvent(event)) {
    return undefined;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text : ''))
    .join('');
  return text.trim().length > 0 ? text : undefined;
}

/**
 * 从尾部向前找「可被替换的实时叙述」位置。
 *
 * 只跨越 `tool_result` 与 tool-only assistant——它们不携带叙述语义。一旦遇到
 * 真正的内容行（正文 / 思考 / 用户消息 / 其它系统事件）就停下：再往前就不属于
 * 同一个叙述段了。
 */
export function findReplaceableLiveNarrationIndex(
  events: AgentMessage[],
  text: string,
  isLiveNarration: (event: AgentMessage) => boolean,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'tool_result') {
      continue;
    }
    if (event?.kind !== 'assistant') {
      break;
    }
    if (isLiveNarration(event)) {
      return index;
    }
    if (isToolOnlyAssistantEvent(event)) {
      continue;
    }
    if (isNarrationOnlyAssistantEvent(event)) {
      const existingText = narrationTextFromAssistantEvent(event);
      if (
        existingText
        && (
          existingText === text
          || existingText.startsWith(text)
          || text.startsWith(existingText)
        )
      ) {
        return index;
      }
      break;
    }
    break;
  }
  return undefined;
}

/**
 * 纯文本叙述的插入点：尾部连续 tool-only assistant（可跨 `tool_result`）之前。
 *
 * **只用于"这段文字属于这些工具之前"的运行时**（OpenCode / pi 的流式叙述在工具
 * 事件之后才 finalize）。不要用它放最终答复——见本文件头注释。
 */
export function findNarrationAssistantInsertionIndex(events: AgentMessage[]): number | undefined {
  let insertAt: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'tool_result') {
      continue;
    }
    if (event?.kind !== 'assistant') {
      break;
    }
    if (!isToolOnlyAssistantEvent(event)) {
      break;
    }
    insertAt = index;
  }
  return insertAt;
}

/** 在 `index` 之后是否还有 tool-only assistant 事件（到用户消息为止）。 */
export function hasToolOnlyAssistantAfterIndex(events: AgentMessage[], index: number): boolean {
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event?.kind === 'user') {
      return false;
    }
    if (isToolOnlyAssistantEvent(event)) {
      return true;
    }
  }
  return false;
}

export type NarrationPlacement = {
  events: AgentMessage[];
  /** 本次放置走的是哪条规则——便于测试与线上诊断。 */
  strategy: 'replace-live' | 'insert-before-tools' | 'append';
};

/**
 * 放置一条纯文本叙述事件。
 *
 * 规则顺序：
 * 1. 能原地替换实时叙述（同一段文字的后半段）→ 替换，保持原位置；
 * 2. 本运行时会把叙述 finalize 到工具事件之后（OpenCode / pi）→ 允许插到尾部
 *    工具之前。这两个运行时的叙述本来就属于「工具之前」，即便工具已经完成；
 * 3. 否则 → 追加到末尾。**最终答复必须走这条**：它出现在已完成的工作之后，
 *    任何"插到工具之前"的处理都会把答案顶到回合中部。
 *
 * `allowInsertBeforeTools` 由调用方按 agent kind 决定：只有会把叙述 finalize 到
 * 工具事件之后的运行时才需要第 2 条；Claude/Codex 的顺序本就正确，给它们开这个
 * 口子只会制造错位。
 */
export function placeNarrationEvent(
  events: AgentMessage[],
  event: Extract<AgentMessage, { kind: 'assistant' }>,
  options: {
    narrationText: string | undefined;
    isLiveNarration: (candidate: AgentMessage) => boolean;
    allowInsertBeforeTools: boolean;
  },
): NarrationPlacement {
  const { narrationText, isLiveNarration, allowInsertBeforeTools } = options;

  const replaceAt = narrationText != null
    ? findReplaceableLiveNarrationIndex(events, narrationText, isLiveNarration)
    : undefined;
  if (replaceAt != null) {
    return {
      events: events.map((entry, index) => (index === replaceAt ? event : entry)),
      strategy: 'replace-live',
    };
  }

  if (allowInsertBeforeTools) {
    const insertAt = findNarrationAssistantInsertionIndex(events);
    if (insertAt != null) {
      return {
        events: [...events.slice(0, insertAt), event, ...events.slice(insertAt)],
        strategy: 'insert-before-tools',
      };
    }
  }

  return { events: [...events, event], strategy: 'append' };
}
