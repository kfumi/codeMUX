import type { CodeMuxAssistantMessage, CodeMuxAssistantPart } from './convertAgentEvents';

/**
 * 历史身份稳定 —— 对应 Paseo 的第三道边界（`areLayoutItemsEquivalent` +
 * `useRevisedHistoryRows` + 行级 memo 三层配合）。
 *
 * ## 为什么需要它
 *
 * `convertAgentEventsToAssistantMessages` 每次都会为**全部**历史事件重建全新的
 * 消息对象。而下游 assistant-ui 的转换缓存以 `WeakMap<外部消息对象, ThreadMessage>`
 * 为键 —— 对象每次都是新的，于是**缓存 100% miss**，整条线程消息被反复重新转换、
 * 反复重新渲染。Paseo 的量化结论是：没有这层 memo 边界时，每一次合并 tick 都会
 * 重渲染全部已挂载行（手机上约 50 行，每 tick 100–250ms JS）。
 *
 * ## 做法
 *
 * 不重写那个带 splice/merge/回溯附加语义的 fold（风险高），而是在**出口**做一次
 * 协调：把这次算出的结果与上次的结果按 `id` 对齐，**结构等价的消息与部件直接
 * 复用上一次的对象引用**。等价性判定是"引用优先"的 —— 只要引用相同就 O(1) 返回，
 * 因此在本项目里：
 *
 * - `data-codemux-event` 部件的 `event` 由 `cloneEventOnce` 的 WeakMap 提供，
 *   同一源事件跨多次转换得到**同一个**克隆对象 → 引用命中，O(1)；
 * - `tool-call` 的 `args` 里的大字符串（Write 的整份文件内容）来自稳定的事件
 *   对象 → 叶子层引用命中，O(1)。
 *
 * ## 为什么"比较最终状态"是安全的
 *
 * fold 过程中确实会**原地改写**先前产出的消息（工具结果回填、会话摘要挂到尾部、
 * 最终消息标记）。但那些改写只作用于**本次运行自己产出的**对象；上一次的产出在
 * 它的那次运行结束后就不再被触碰。因此"这次的最终结果"与"上次的最终结果"结构
 * 相等 ⇒ 内容完全相同 ⇒ 复用上次的对象是正确且等价的。
 *
 * 判定失败（含超过深度上限的情形）一律退回"使用新对象"，即退化为改动前的行为，
 * 不会引入错误。
 */

/** 结构比较的深度上限。超出即判为不等 —— 保守退化，不会误判为相等。 */
const MAX_COMPARE_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 引用优先的深比较。引用相同立即返回 true（这是热路径上唯一会被走到的分支）；
 * 引用不同才递归比较，且深度有上限。
 */
function isEquivalent(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) {
    return true;
  }
  if (depth >= MAX_COMPARE_DEPTH) {
    return false;
  }
  if (a === null || b === null || typeof a !== typeof b) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!isEquivalent(a[index], b[index], depth + 1)) {
        return false;
      }
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!isEquivalent(a[key], b[key], depth + 1)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function arePartsEquivalent(a: CodeMuxAssistantPart, b: CodeMuxAssistantPart): boolean {
  if (a === b) {
    return true;
  }
  if (a.type !== b.type) {
    return false;
  }

  switch (a.type) {
    case 'text':
    case 'reasoning':
      return a.text === (b as typeof a).text;
    case 'tool-call': {
      const other = b as typeof a;
      return a.toolCallId === other.toolCallId
        && a.toolName === other.toolName
        && a.result === other.result
        && a.isError === other.isError
        && isEquivalent(a.args, other.args);
    }
    case 'data-codemux-event': {
      const other = b as typeof a;
      return a.eventKind === other.eventKind && isEquivalent(a.event, other.event);
    }
    default:
      return false;
  }
}

/**
 * 在部件层复用引用。只有"长度相同且逐个等价"时才整体返回上一次的数组引用，
 * 使 `content` 数组本身也保持稳定。
 *
 * 同时报告复用了多少个部件：调用方据此决定"整条消息连同内容数组一起复用"还是
 * "沿用本次新造的消息对象、只换回稳定的部件"。
 */
function reconcileParts(
  next: CodeMuxAssistantPart[],
  previous: CodeMuxAssistantPart[] | undefined,
): { parts: CodeMuxAssistantPart[]; reused: number } {
  if (!previous || previous.length !== next.length) {
    return { parts: next, reused: 0 };
  }

  let reused = 0;
  let changed = false;
  const reconciled: CodeMuxAssistantPart[] = new Array(next.length);
  for (let index = 0; index < next.length; index += 1) {
    const candidate = next[index];
    const prior = previous[index];
    if (prior && arePartsEquivalent(candidate, prior)) {
      reconciled[index] = prior;
      reused += 1;
    } else {
      reconciled[index] = candidate;
      changed = true;
    }
  }

  return { parts: changed ? reconciled : previous, reused };
}

function areMessagesEquivalent(a: CodeMuxAssistantMessage, b: CodeMuxAssistantMessage): boolean {
  if (a.id !== b.id || a.role !== b.role) {
    return false;
  }
  if (a.content.length !== b.content.length) {
    return false;
  }
  return isEquivalent(a.metadata, b.metadata);
}

/**
 * 把 `next` 与上一次的产出对齐，复用未变化部分的对象引用。
 *
 * 按 `id` 匹配而非按下标匹配：fold 会向中间 `splice` 消息、也会把消息合并进
 * 前一条，因此下标会移动，而 `id` 在同一条事件前缀下是确定性的。
 */
export function reconcileAssistantMessages(
  next: CodeMuxAssistantMessage[],
  previous: readonly CodeMuxAssistantMessage[] | undefined,
): CodeMuxAssistantMessage[] {
  if (!previous || previous.length === 0 || next.length === 0) {
    return next;
  }

  const previousById = new Map<string, CodeMuxAssistantMessage>();
  for (const message of previous) {
    previousById.set(message.id, message);
  }

  const reconciled: CodeMuxAssistantMessage[] = new Array(next.length);

  for (let index = 0; index < next.length; index += 1) {
    const candidate = next[index];
    const prior = previousById.get(candidate.id);

    if (!prior) {
      reconciled[index] = candidate;
      continue;
    }

    const { parts, reused } = reconcileParts(candidate.content, prior.content);

    if (reused === 0) {
      // 一个部件都没能复用 ⇒ 沿用本次新造的消息对象，不做无谓的浅拷贝。
      reconciled[index] = candidate;
      continue;
    }

    if (parts === prior.content && areMessagesEquivalent(candidate, prior)) {
      // 内容数组与元数据都与上次一致 ⇒ 整条消息对象可以原样复用。
      reconciled[index] = prior;
      continue;
    }

    reconciled[index] = { ...candidate, content: parts };
  }

  return reconciled;
}
