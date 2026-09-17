/**
 * 分帧绘制（paced reveal）的策略层 —— 对应 Paseo 的第五道边界。
 *
 * 本模块是**纯函数**，刻意与 rAF 时钟分离（Paseo 的 `text-reveal.ts` 同样如此），
 * 因此可以脱离渲染器直接测收敛性与突发削平。
 *
 * ## 要解决的问题
 *
 * Paseo 的文档写得很直接（`docs/agent-stream-performance.md:20-24`）：
 *
 * > Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing
 * > window carries however many characters the model produced in those 60ms, which
 * > swings by an order of magnitude within a single turn. Painting each delta as it
 * > lands makes the size of those lumps visible, and that is what reads as jagged.
 * > ... **Shrinking the coalescing window does not fix this.**
 *
 * CodeMUX 原本只有 50ms 窗口的**速率上限**，没有**均匀化**：批次大小在一个回合内
 * 可能相差一个数量级，而批次直接上屏 —— 用户看到的就是"一顿一顿"。
 *
 * ## 做法
 *
 * 到达只决定**目标**，释放速率由 **backlog 推导**：
 * `step = ceil(backlog × elapsed / horizonMs)`，下限 1 字符。
 * 突发只会让文字**追赶得更快**，而不会让它**跳**。
 *
 * ## 不变量
 *
 * 1. **首次见到一段文本整段渲染** —— 历史补全、时间线回放、虚拟化行重挂载
 *    都无需特例（对应 `beginTextReveal`）。
 * 2. **离开 streaming 立即补全** —— 已完成的回合绝不残留半截文字
 *    （对应 `completeTextReveal`）。
 * 3. **按时长归一，而不是按字符数** —— 见上。
 * 4. **剪裁点对齐字素簇** —— 不会把 emoji / 组合字符切开闪一下。
 * 5. **store 存全文，只有渲染切片被节流** —— 见 hook；本模块只算切片长度。
 */

/** 让 backlog 在 150ms 内释放完。与 Paseo 取同一值。 */
export const DEFAULT_REVEAL_HORIZON_MS = 150;

/**
 * 单帧流逝时间的上限。帧被长时间阻塞后（例如一个长任务），若按真实 elapsed
 * 归一，backlog 会在一帧内全部倾泻 —— 那正是要避免的"跳"。截断到 250ms
 * 使恢复是渐进的（Paseo 的 `MAX_ELAPSED_MS` 同值）。
 */
const MAX_ELAPSED_MS = 250;

/** 字素簇回溯的最大步数，防止病态输入造成长循环。 */
const MAX_BOUNDARY_BACKOFF = 64;

const COMBINING_MARK_RE = /\p{Mark}/u;

/** ZWJ：粘合 emoji 序列的连接符。 */
const ZWJ = 0x200d;

function isVariationSelector(code: number): boolean {
  return code >= 0xfe00 && code <= 0xfe0f;
}

/** 肤色修饰符（Emoji Modifier Fitzpatrick），属于前一个字素簇。 */
function isSkinToneModifier(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

/**
 * 该码元是否**附着在前一个字符上**（剪在它前面会拆开一个字素簇）。
 *
 * 注意 ZWJ 不在此列：剪在 ZWJ **之前**（把连接符留在渲染切片之外）是安全的 ——
 * 切片会以基础 emoji 结尾，属于正常的"渐进显示"中间态。真正有问题的是把 ZWJ
 * **留在切片末尾**，那由一个单独的悬挂判定处理。
 */
function attachesToPrevious(code: number): boolean {
  if (isVariationSelector(code) || isSkinToneModifier(code)) {
    return true;
  }
  if (Number.isNaN(code)) {
    return false;
  }
  return COMBINING_MARK_RE.test(String.fromCharCode(code));
}

/** 该码元是否**悬挂**（把它留在切片结尾会渲染成孤立修饰符 / 孤立代理）。 */
function isDanglingAtEnd(code: number): boolean {
  if (code === ZWJ) {
    return true;
  }
  // 高位代理：切开会把一个码点变成 U+FFFD。
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 把剪裁点回退到安全的字素簇边界。
 *
 * 用逐码元判定而非 `Intl.Segmenter`：Segmenter 需要 O(全文) 分词，而本函数每帧
 * 都要跑一次。逐码元回溯是 O(1)，覆盖代理对、组合标记、ZWJ 序列、变体选择符与
 * 肤色修饰符 —— 实际会遇到的类目。
 */
export function clampToSafeRevealBoundary(text: string, index: number): number {
  let end = Math.max(0, Math.min(index, text.length));
  if (end === 0 || end >= text.length) {
    return end;
  }

  for (let guard = 0; guard < MAX_BOUNDARY_BACKOFF && end > 0; guard += 1) {
    if (isDanglingAtEnd(text.charCodeAt(end - 1))) {
      end -= 1;
      continue;
    }
    if (attachesToPrevious(text.charCodeAt(end))) {
      end -= 1;
      continue;
    }
    break;
  }

  return end;
}

/**
 * 本帧应释放的字符数。到达决定目标，速率由 backlog 推导。
 *
 * `horizonMs <= 0` 表示关闭节流（"到达即绘制"），用于 A/B 对照基线。
 */
export function computeRevealStep(input: {
  backlog: number;
  elapsedMs: number;
  horizonMs?: number;
}): number {
  const { backlog } = input;
  if (backlog <= 0) {
    return 0;
  }

  const horizonMs = input.horizonMs ?? DEFAULT_REVEAL_HORIZON_MS;
  if (horizonMs <= 0) {
    return backlog;
  }

  const elapsedMs = Math.min(Math.max(input.elapsedMs, 0), MAX_ELAPSED_MS);
  if (elapsedMs >= horizonMs) {
    return backlog;
  }

  const step = Math.ceil((backlog * elapsedMs) / horizonMs);
  return Math.min(backlog, Math.max(1, step));
}

/**
 * 由当前状态推导下一帧的已释放长度。
 *
 * - `revealed <= 0` 且目标是正文 ⇒ **首次见到整段渲染**（不变量 1）。
 * - `target <= revealed` ⇒ 目标收缩或已补全 ⇒ 直接吸附（不变量 2 的收尾）。
 */
export function resolveRevealedLength(input: {
  text: string;
  revealed: number;
  targetLength: number;
  elapsedMs: number;
  horizonMs?: number;
}): number {
  const { text, revealed, targetLength } = input;

  if (targetLength <= 0) {
    return 0;
  }
  if (targetLength <= revealed) {
    return targetLength;
  }
  if (revealed <= 0) {
    return targetLength;
  }

  const backlog = targetLength - revealed;
  const step = computeRevealStep({
    backlog,
    elapsedMs: input.elapsedMs,
    horizonMs: input.horizonMs,
  });
  const advanced = Math.min(targetLength, revealed + step);
  // 剪裁点可能回退，但绝不能退到比已显示内容更早的位置（否则文字会"倒退"）。
  return Math.max(revealed, clampToSafeRevealBoundary(text, advanced));
}
