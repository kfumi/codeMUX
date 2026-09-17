import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';

import { recordRevealFrame } from '@/lib/streamSmoothness';
import { DEFAULT_REVEAL_HORIZON_MS, resolveRevealedLength } from './streamTextReveal';

/**
 * 分帧绘制的时钟层 —— 只管 rAF 接线与**提交节流**，策略全在纯函数
 * `streamTextReveal.ts` 里。这个切分是从 Paseo 学的：策略可脱离渲染器测试，
 * 帧时钟则无可避免地要有副作用。
 *
 * ## 不变量：store 存全文，只有渲染切片被节流
 *
 * 本 hook **不改动 store**，只决定"这一刻画到第几个字符"。store 里始终是全文，
 * 因此复制/选中/滚动几何与屏幕上看到的完全一致。
 *
 * ## 为什么必须把提交频率压在 60Hz 以下（重要，是一个真实踩过的坑）
 *
 * 把释放**算出来**很便宜，但把它**画上去**不便宜：每次提交都会让
 * `Streamdown` 对累积正文重新分块，并对尾部未闭合代码块重跑 Shiki 分词。
 * 按 60Hz 提交等于每秒 60 次 Markdown 解析 + 语法高亮。
 *
 * 后果不只是这一处变慢 —— `DotMatrix` 的 SVG `opacity` 闪烁与
 * `RunningElapsedTimer` 的 `.shimmer`（`background-clip: text`）都是**绘制类**
 * 动画，无法卸载到合成线程；主线程被占满时它们会**全应用一起冻住**（表现为
 * "所有 loading 动效失效"）。Paseo 可以在 60Hz 做分帧绘制，是因为它的每帧渲染
 * 只是一个纯文本 `<Text>`，没有解析成本 —— 这个前提在 CodeMUX 不成立。
 *
 * 因此这里按 `minRenderIntervalMs`（默认 40ms ≈ 25Hz）节流**提交**，这个频率
 * 低于改动前由 50ms 窗口驱动的大约 20–40 次/秒，所以是净减少；同时因为它把字符
 * **均匀**铺开，观感仍远好于"到达即绘制"的成块跳动。节流用的是**跨实例共享**的
 * 闸门（见 `tryAcquireCommitSlot`），否则同组件的两个实例会错开提交、把频率翻倍。
 *
 * ## 为什么帧循环是常驻的
 *
 * 朴素的"只在有 backlog 时排帧"会在追平后停掉循环，导致下一批文字到达时**没有
 * 任何东西推动释放**。流式期间常驻一个 rAF 回调、追平后仅做几次算术比较，是
 * 实现上最省心也最省成本的做法。
 *
 * ## 开关
 *
 * - `localStorage['codemux:textRevealHorizonMs'] = '0'` —— 关闭分帧绘制
 *   （"到达即绘制"），用于 A/B 对照基线。
 * - `localStorage['codemux:textRevealMinFrameMs'] = '80'` —— 降低提交频率，
 *   在主线程吃紧时进一步让出预算。
 */

const HORIZON_STORAGE_KEY = 'codemux:textRevealHorizonMs';
const MIN_FRAME_STORAGE_KEY = 'codemux:textRevealMinFrameMs';

/**
 * 两次可见提交之间的最小间隔。
 *
 * 取 40ms（≈25Hz）：低于改动前 50ms 窗口驱动的 20–40 次/秒，因此每次 Markdown
 * 重解析的总量是净减少；同时 40ms 的更新间隔在手感上仍然连续（远好于
 * "到达即绘制"实测 p95 383ms 的成块跳动）。
 */
const DEFAULT_MIN_FRAME_MS = 40;

function readNumberSetting(key: string, fallback: number, minimum: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw != null && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= minimum) {
        return parsed;
      }
    }
  } catch {
    // localStorage 不可用（隐私模式、测试环境）时沿用默认值。
  }
  return fallback;
}

let cachedHorizonMs: number | null = null;
let cachedMinFrameMs: number | null = null;

function readHorizonMs(): number {
  if (cachedHorizonMs === null) {
    cachedHorizonMs = readNumberSetting(HORIZON_STORAGE_KEY, DEFAULT_REVEAL_HORIZON_MS, 0);
  }
  return cachedHorizonMs;
}

function readMinFrameMs(): number {
  if (cachedMinFrameMs === null) {
    cachedMinFrameMs = readNumberSetting(MIN_FRAME_STORAGE_KEY, DEFAULT_MIN_FRAME_MS, 0);
  }
  return cachedMinFrameMs;
}

/** 仅供测试复位缓存用。 */
export function resetRevealHorizonCache(): void {
  cachedHorizonMs = null;
  cachedMinFrameMs = null;
  lastCommitAtGlobal = 0;
}

/**
 * 全局提交闸门。
 *
 * 一个 `StreamingContent` 会同时跑**两个**分帧绘制实例（正文与思考）。若各自
 * 独立计时，两者会互相错开、把组件的可见提交频率抬到 2 倍 —— 那就抵消了节流的
 * 目的。让它们共用同一个闸门，"整个组件"的提交频率才真正被压在 minFrameMs 以下。
 *
 * 闸门只造成延迟、不会丢弃：常驻的帧循环会在下一次闸门打开时把待提交内容补上，
 * 流式结束时 effect 的补全分支也会兜底。
 */
let lastCommitAtGlobal = 0;

function tryAcquireCommitSlot(now: number, minFrameMs: number): boolean {
  if (now - lastCommitAtGlobal < minFrameMs) {
    return false;
  }
  lastCommitAtGlobal = now;
  return true;
}

/**
 * 返回应当渲染的文本切片。
 *
 * @param text      累积全文（目标）
 * @param streaming 是否正在流式。为 false 时立即补全（不变量 2）。
 */
export function useStreamingTextReveal(text: string, streaming: boolean): string {
  // 目标值放 ref：帧回调需要读到**最新**的 text，而 effect 不应因 text 变化而重启
  // （重启会重置 elapsed 计时，backlog 会永远追不上）。
  const targetRef = useRef(text);
  useLayoutEffect(() => {
    targetRef.current = text;
  }, [text]);

  // 已释放长度是权威来源，放在 ref；用一个计数器触发重渲染，避免 ref 与 state
  // 两份真相互相覆盖。
  const revealedRef = useRef(text.length);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const horizonMs = readHorizonMs();
    const minFrameMs = readMinFrameMs();

    // 不变量 1：首次见到一段文本整段渲染（历史补全、时间线回放、虚拟化行重挂载
    // 都无需特例）。不变量 2：离开 streaming 立即补全。关闭分帧绘制时也直接补全。
    if (!streaming || horizonMs <= 0) {
      const limit = targetRef.current.length;
      if (revealedRef.current !== limit) {
        revealedRef.current = limit;
        forceRender();
      }
      return;
    }

    let frame = 0;
    let cancelled = false;
    let lastFrameAt = performance.now();
    let hasUncommitted = false;

    const step = () => {
      if (cancelled) {
        return;
      }
      frame = 0;

      const now = performance.now();
      const elapsedMs = now - lastFrameAt;
      lastFrameAt = now;

      const target = targetRef.current;
      const current = revealedRef.current;
      const next = resolveRevealedLength({
        text: target,
        revealed: current,
        targetLength: target.length,
        elapsedMs,
        horizonMs,
      });

      if (next > current) {
        revealedRef.current = next;
        hasUncommitted = true;
      }

      // 提交受全局闸门约束。不在这里为"已追平"开特例：闸门只延迟不丢弃，帧循环
      // 常驻，下一次闸门打开时一定会把剩余字符补上。
      let committed = 0;
      if (hasUncommitted && tryAcquireCommitSlot(now, minFrameMs)) {
        hasUncommitted = false;
        committed = next - current;
        forceRender();
      }

      // 平滑度采样：统计的是**可见更新**，被节流跳过的帧传 0。
      recordRevealFrame(committed, now);

      // 常驻排帧：追平后不应停掉循环，否则下一批文字到达时无人推动释放。
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [streaming]);

  const revealed = revealedRef.current;
  return revealed >= text.length ? text : text.slice(0, revealed);
}
