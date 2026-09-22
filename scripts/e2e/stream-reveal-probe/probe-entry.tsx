/**
 * 流式绘制（paced reveal）A/B 探针的页面入口。
 *
 * 回答「工单 6」：`useStreamingTextReveal` 的分帧绘制该保留、加大节拍，还是移除？
 * PI-Desktop 在决策 D152 里明确不做 rAF typewriter 循环，本仓库第四轮加了它，
 * 并把代价标记为「真实的未知数」。
 *
 * ## 四条臂
 *
 * - `direct`         —— **真基线**：不调用 hook，直接把正文 prop 渲染进 Streamdown。
 *                       这就是"移除分帧绘制"后的样子。
 * - `reveal-default` —— 生产现状（默认 horizon，minFrame 40ms ≈ 25Hz）。
 * - `reveal-slow`    —— 候选（minFrame 80ms ≈ 12.5Hz）。
 * - `horizon-zero`   —— 代码注释里写明的 A/B 开关（`codemux:textRevealHorizonMs = 0`）。
 *                       保留它是为了核实"关闭分帧绘制"到底等不等于"到达即绘制"。
 *
 * ## 保真度（必须知道，否则读数会被误读）
 *
 * 渲染的正是生产配置：真实 `useStreamingTextReveal` + 真实
 * `CODEMUX_MARKDOWN_STREAMDOWN_PROPS`（含 Shiki code 插件）+ 真实 `Streamdown`，
 * 且**刻意不加 `memo`**——生产里 `StreamingContent` 也没有 memo。
 *
 * 三件事是刻意复刻的，因为少任何一件都会让结论失真：
 *
 * 1. **上游按生产的节流节奏喂文本**。生产里 `agentStore` 是 50ms 窗口的
 *    leading-edge + trailing 双触发，所以正文 prop 的更新率由**到达率**决定。
 *    如果到达率本身只有约 6 次/秒，到达即绘制本来就已经很平滑，分帧绘制看起来
 *    毫无收益——那是夹具的错，不是机制的错。
 * 2. **文本含持续增长的代码围栏**。纯散文的话 Shiki 根本不参与，测量会漏掉生产里
 *    最大的单项成本。
 * 3. **正文长度不越过生产上限**（`agentStore.appendStreamingPreview`，尾部 16384）。
 *    越过上限后正文不再增长，每次提交的重解析量恒定，A/B 差值会被压扁。
 *
 * ## 度量口径
 *
 * - **可见更新**由"被渲染的那段文本字符串身份变化"定义，四条臂同一口径。
 *   不能用 `streamSmoothness.recordRevealFrame`——它只在 reveal 路径里被调用，
 *   关闭分帧绘制后恒为空，无法跨臂比较。
 * - 提交耗时/次数来自 `<Profiler>`；这要求**链接 profiling 构建**
 *   （生产版 React 里 `<Profiler>` 的 `onRender` 不会被调用。
 *   runner 已把 `react-dom` 别名到 `react-dom/profiling`）。
 * - 长任务来自 `PerformanceObserver('longtask')`。
 * - `hook 的 rAF 回调数` 是"常驻帧循环是否还在"的直接证据。
 *
 * ## 已知不覆盖
 *
 * 滚动跟随用极简实现（内容变化后钉到底部），生产用的是 `useTranscriptFollowLatest`；
 * 不含长会话挂载窗口与 `content-visibility`（那些由 `transcript-probe` 覆盖）。
 */
import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import {
  resetRevealHorizonCache,
  useStreamingTextReveal,
} from '@/components/agent/assistant-ui/useStreamingTextReveal';
import { DEFAULT_REVEAL_HORIZON_MS } from '@/components/agent/assistant-ui/streamTextReveal';
import {
  coefficientOfVariation,
  percentile,
  readAndResetSmoothness,
  resetSmoothness,
} from '@/lib/streamSmoothness';
import { createBurstyStreamSchedule, pumpBurstySchedule } from '@/lib/dev/burstyStreamSchedule';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { createIncrementalBlockParser } from '@/lib/incrementalMarkdownBlocks';
import type { MarkdownBlockParser } from '@/lib/incrementalMarkdownBlocks';
import { primeCodeHighlighting } from '@/lib/codeHighlightWarmup';

/** 与 `agentStore.appendStreamingPreview` 同口径：只保留尾部这么多字符。 */
const STREAM_PREVIEW_MAX_CHARS = 16_384;

const HORIZON_STORAGE_KEY = 'codemux:textRevealHorizonMs';
const MIN_FRAME_STORAGE_KEY = 'codemux:textRevealMinFrameMs';

const STREAM_TOTAL_MS = 12_000;
const SETTLE_AFTER_STREAM_MS = 1_200;
const BURST_SEED = 20260921;
/** 与 `agentStore` 的 leading-edge + coalesce 窗口一致。 */
const STORE_FLUSH_WINDOW_MS = 50;

/** 预热臂在开始流式前先等多久，让离屏高亮把语法与引擎热起来。 */
const WARMUP_MS = 900;

interface ArmConfig {
  minFrame: number;
  horizon: number;
  /** 诊断臂开关：true 时把 Markdown/Shiki 换成纯文本，用来量出它的占比。 */
  plain?: boolean;
  /** 诊断臂开关：true 时保留 Markdown 解析与 DOM，只去掉 Shiki 高亮插件。 */
  noCode?: boolean;
  /** 诊断臂开关：true 时在流式开始前调用生产用的预热函数把 Shiki 热起来。 */
  warm?: boolean;
  /** 诊断臂开关：true 时流式期间不高亮，流式结束后才把高亮装上（近似"只高亮已闭合围栏"）。 */
  lazyCode?: boolean;
  /** 候选修法 C：注入增量分块（只重解析尾部块），与 `reveal-default` 逐项对照。 */
  tailLex?: boolean;
  /**
   * 诊断臂开关：把**还没闭合的尾块**从 Markdown 路径里摘出来按纯文本渲染。
   * 一次回答两件事：① 残余提交耗时里"尾部块"占多少（与 `reveal-default` 之差）；
   * ② "未闭合围栏延迟解析/高亮"这条思路的收益上界（要不要为它牺牲观感）。
   */
  tailPlain?: boolean;
}

const ARMS = {
  direct: { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS },
  'reveal-default': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS },
  'reveal-slow': { minFrame: 80, horizon: DEFAULT_REVEAL_HORIZON_MS },
  'horizon-zero': { minFrame: 40, horizon: 0 },
  // 诊断臂：与 `reveal-default` 逐项相同，只替换 Markdown 的渲染方式。
  // `reveal-nocode` 与 `reveal-default` 之差 = Shiki 高亮；`reveal-plain` 与 `reveal-nocode` 之差 = 解析 + DOM。
  // `reveal-warm` / `reveal-lazy-code` 则是两条**候选修法**的探路臂，同样不参与保留/移除判定。
  'reveal-plain': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, plain: true },
  'reveal-nocode': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, noCode: true },
  'reveal-warm': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, warm: true },
  'reveal-lazy-code': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, lazyCode: true },
  'reveal-tail-lex': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, tailLex: true },
  // 残余成本拆解：尾部块（还在增长的那一块）按纯文本画，其余已闭合块照常走 Markdown。
  'reveal-tail-plain': { minFrame: 40, horizon: DEFAULT_REVEAL_HORIZON_MS, tailPlain: true },
  // #7（rAF 帧合并器）的等价比：minFrame 16ms ≈ 每帧一次 flush，其余与现状一致。
  'reveal-frame': { minFrame: 16, horizon: DEFAULT_REVEAL_HORIZON_MS },
} satisfies Record<string, ArmConfig>;

type ArmName = keyof typeof ARMS;

/**
 * 本页面运行的臂。放在模块级是因为 `BubbleShell` 也要知道（它决定是否注入增量分块），
 * 而宿主在 `loadFile` 之前就把 `?mode=` 写进了 URL。`readArm` 是函数声明，会被提升。
 */
const ACTIVE_ARM_CONFIG = ARMS[readArm()];

/** `reveal-tail-lex` 臂记录下来的全部输入，用于流式结束后的正确性回放自检。 */
const tailLexInputs: string[] = [];

/**
 * 包一层，只记录交给分块器的输入。**不做**逐次比对——那会把要量的成本翻倍；
 * 正确性交给结算期的回放自检。
 */
function createTrackedIncrementalParser(inputs: string[]): MarkdownBlockParser {
  const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  return (markdown: string) => {
    inputs.push(markdown);
    return incremental(markdown);
  };
}

/**
 * 结算期自检：用同一串输入重放一遍增量分块，与参考实现逐项比对，返回不一致的次数。
 * 它在测量窗口之外执行，所以慢一点没关系。
 */
function verifyIncrementalBlocks(inputs: readonly string[]): number {
  const replay = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  let mismatches = 0;
  for (const markdown of inputs) {
    if (JSON.stringify(replay(markdown)) !== JSON.stringify(parseMarkdownIntoBlocks(markdown))) {
      mismatches += 1;
    }
  }
  return mismatches;
}

/**
 * 宿主（`electron-probe-main.cjs`）在 `loadFile` 之后**立刻**读这个全局，
 * 所以它必须在模块求值阶段就存在——不能等探针跑完再挂。
 */
let resolveProbe: (value: unknown) => void = () => {};
const probePromise = new Promise<unknown>((resolve) => {
  resolveProbe = resolve;
});
(globalThis as unknown as {
  __CODEMUX_TRANSCRIPT_PROBE__: { promise: Promise<unknown> };
}).__CODEMUX_TRANSCRIPT_PROBE__ = { promise: probePromise };

const pageErrors: string[] = [];
window.addEventListener('error', (event) => {
  pageErrors.push(`error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  pageErrors.push(`rejection: ${String((event as PromiseRejectionEvent).reason)}`);
});

/** 与 `agentStore.appendStreamingPreview` 等价。 */
function appendPreview(previous: string, chunk: string): string {
  if (!previous) {
    return chunk.length > STREAM_PREVIEW_MAX_CHARS
      ? chunk.slice(-STREAM_PREVIEW_MAX_CHARS)
      : chunk;
  }
  if (previous.length + chunk.length <= STREAM_PREVIEW_MAX_CHARS) {
    return previous + chunk;
  }
  if (chunk.length >= STREAM_PREVIEW_MAX_CHARS) {
    return chunk.slice(-STREAM_PREVIEW_MAX_CHARS);
  }
  return `${previous.slice(-(STREAM_PREVIEW_MAX_CHARS - chunk.length))}${chunk}`;
}

/**
 * 造一份"像真答案"的长 Markdown：交替的段落 + **持续增长的代码围栏**。
 * 长度精确等于这次排程会推出的字符总数（并夹在上限内），
 * 保证测量全程正文都在增长、不发生饱和。
 */
function buildAnswerDocument(exactLength: number): string {
  const parts: string[] = [];
  let index = 0;
  let length = 0;

  while (length < exactLength) {
    const section = [
      '',
      `## 步骤 ${index}`,
      '',
      '先看数据层。这里的问题不在查询本身，而在每次提交都会重建整份快照，',
      '于是成本随历史长度线性增长，而不是随"正在看的那一段"增长。',
      '',
      '```ts',
      `export function step${index}(input: string): number {`,
      '  const rows = input.split(String.fromCharCode(10));',
      `  return rows.filter((row) => row.trim().length > 0).length + ${index};`,
      '}',
      '```',
      '',
      `- 要点一：第 ${index} 步的测量必须落在真实引擎里`,
      '- 要点二：把"遍历"和"重建对象"分开处理',
      `- 要点三：改完之后，第 ${index} 步的耗时应当与历史长度解耦`,
      '',
    ].join('\n');
    parts.push(section);
    length += section.length;
    index += 1;
  }

  return parts.join('').slice(0, exactLength);
}

/**
 * 诊断臂 `reveal-nocode` 专用：保留 Markdown 解析与 DOM，只去掉 Shiki 高亮插件。
 * 必须是模块级常量——每帧新建对象会破坏 Streamdown 的 Block 级 memo，
 * 那样量出来的是"对象身份不稳"的代价，不是高亮的代价。
 */
const NO_CODE_STREAMDOWN_PROPS: typeof CODEMUX_MARKDOWN_STREAMDOWN_PROPS = {
  ...CODEMUX_MARKDOWN_STREAMDOWN_PROPS,
  plugins: {},
};

/** 生产里 `StreamingContent` 流式分支的标记结构（去掉状态订阅）。 */
function BubbleShell({
  children,
  plain,
  noCode,
}: {
  children: ReactNode;
  plain?: boolean;
  noCode?: boolean;
}) {
  /**
   * 候选修法 C：把增量分块注入 `Streamdown` 的官方缝隙 `parseMarkdownIntoBlocksFn`。
   * 其余臂传 `undefined`（= 上游默认实现），两条臂的差别只有这一处。
   */
  const blockParser = useMemo(
    () => (ACTIVE_ARM_CONFIG.tailLex === true ? createTrackedIncrementalParser(tailLexInputs) : undefined),
    [],
  );
  /**
   * 残余成本拆解 / "延迟解析尾块"的收益上界（见 `ArmConfig.tailPlain`）。
   * 用上游自己的分块器切出"已闭合的前缀"与"还在增长的尾块"：前缀照常走 Markdown，尾块按纯文本。
   *
   * **注意这是诊断臂，不是候选修法**：尾块在流式期间会失去所有 Markdown 观感（加粗、列表、链接
   * 都要等它闭合），所以它只用来给"值不值得为性能做这个交换"定上界。
   */
  const tailSplit = useMemo(() => {
    if (ACTIVE_ARM_CONFIG.tailPlain !== true) return null;
    const full = typeof children === 'string' ? children : '';
    const blocks = parseMarkdownIntoBlocks(full);
    if (blocks.length <= 1) return { closed: '', open: full };
    const closed = blocks.slice(0, -1).join('');
    return { closed, open: full.slice(closed.length) };
  }, [children]);
  return (
    <div className="mb-2 flex w-full justify-start">
      <div className="w-full min-w-0 space-y-1 text-ui-body leading-relaxed">
        <div
          data-streaming-text="markdown"
          data-plain={plain ? 'true' : undefined}
          data-nocode={noCode ? 'true' : undefined}
          className="relative text-ui-body leading-relaxed text-foreground"
        >
          {plain ? (
            <pre className="whitespace-pre-wrap font-sans">{children}</pre>
          ) : tailSplit ? (
            <>
              <Streamdown {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>{tailSplit.closed}</Streamdown>
              <pre className="whitespace-pre-wrap font-sans">{tailSplit.open}</pre>
            </>
          ) : (
            <Streamdown
              {...(noCode ? NO_CODE_STREAMDOWN_PROPS : CODEMUX_MARKDOWN_STREAMDOWN_PROPS)}
              parseMarkdownIntoBlocksFn={blockParser}
            >
              {children}
            </Streamdown>
          )}
        </div>
      </div>
    </div>
  );
}

interface BubbleProps {
  text: string;
  streaming: boolean;
  onRenderedText: (text: string) => void;
  onPinToBottom: () => void;
  plain?: boolean;
  noCode?: boolean;
}

/** 真基线：不调用 hook，直接渲染 prop。**不加 memo**，与生产一致。 */
function DirectBubble({ text, streaming, onRenderedText, onPinToBottom, plain, noCode }: BubbleProps) {
  useEffect(() => {
    onRenderedText(text);
    onPinToBottom();
  }, [text, onPinToBottom, onRenderedText]);

  if (!streaming && !text) {
    return null;
  }

  return (
    <BubbleShell plain={plain} noCode={noCode}>
      {text}
    </BubbleShell>
  );
}

/** 生产现状。**不加 memo**，与生产一致。 */
function RevealBubble({ text, streaming, onRenderedText, onPinToBottom, plain, noCode }: BubbleProps) {
  const revealed = useStreamingTextReveal(text, streaming);

  useEffect(() => {
    onRenderedText(revealed);
    onPinToBottom();
  }, [revealed, onPinToBottom, onRenderedText]);

  if (!streaming && !revealed) {
    return null;
  }

  return (
    <BubbleShell plain={plain} noCode={noCode}>
      {revealed}
    </BubbleShell>
  );
}

/** 模块级：Profiler 的 onRender 是同步回调，不能依赖 effect 里的初始化。 */
const profilerTotals = { commits: 0, totalMs: 0, maxMs: 0 };

function Probe({ arm }: { arm: ArmName }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  /** 预热臂：预热没完成就不开始流式，这样初始化长任务不会落进测量窗口。 */
  const [warmReady, setWarmReady] = useState(ARMS[arm].warm !== true);

  /** 可见更新的时间戳与每次推进的字符数（四条臂同口径）。 */
  const visibleAtRef = useRef<number[]>([]);
  const visibleCharsRef = useRef<number[]>([]);
  const lastVisibleRef = useRef('');
  /** 最近一次真正被渲染出的文本，用来核实"流式期间到底有没有内容"。 */
  const lastRenderedRef = useRef('');

  const onRenderedText = useCallback((rendered: string) => {
    lastRenderedRef.current = rendered;
    if (rendered === lastVisibleRef.current) {
      return;
    }
    const delta = rendered.length - lastVisibleRef.current.length;
    lastVisibleRef.current = rendered;
    visibleAtRef.current.push(performance.now());
    visibleCharsRef.current.push(delta > 0 ? delta : 0);
  }, []);

  const onPinToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  /**
   * 预热臂：调用**生产里真正发货的**预热函数，而不是等价替身，
   * 这样探针验的就是产品代码路径本身（内部走 `requestIdleCallback`，本页面空闲所以会很快跑完）。
   * 只热 `typescript`：探针语料里的增长围栏就是 ts，热别的语言只会拉长等待。
   */
  useEffect(() => {
    if (ARMS[arm].warm !== true) {
      return;
    }
    primeCodeHighlighting(['typescript']);
    const handle = window.setTimeout(() => setWarmReady(true), WARMUP_MS);
    return () => window.clearTimeout(handle);
  }, [arm]);

  useEffect(() => {
    if (!warmReady) {
      return;
    }
    profilerTotals.commits = 0;
    profilerTotals.totalMs = 0;
    profilerTotals.maxMs = 0;

    /**
     * 长任务只记 `duration` 无法回答"是一次性初始化，还是每次提交都在做"，
     * 所以连开始时刻与归因一起留下；条目只在个位数量级，不截断。
     * `startMs` 相对本次流式开始，方便和"代码围栏开始增长"的时刻对齐。
     */
    const longTaskBase = performance.now();
    const longTasks: { startMs: number; durationMs: number; name: string; containerType: string }[] = [];
    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({
            startMs: Math.round(entry.startTime - longTaskBase),
            durationMs: Math.round(entry.duration * 100) / 100,
            name: entry.name,
            containerType: entry.attribution?.[0]?.containerType ?? 'unknown',
          });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      longTaskObserver = null;
    }

    let framesObserved = 0;
    let frameHandle = 0;
    const countFrame = () => {
      framesObserved += 1;
      frameHandle = requestAnimationFrame(countFrame);
    };
    frameHandle = requestAnimationFrame(countFrame);

    resetSmoothness();
    resetRevealHorizonCache();
    visibleAtRef.current = [];
    visibleCharsRef.current = [];
    lastVisibleRef.current = '';
    lastRenderedRef.current = '';

    const schedule = createBurstyStreamSchedule({
      seed: BURST_SEED,
      totalMs: STREAM_TOTAL_MS,
      // 密集的小批次：让到达率落在生产量级（数十次/秒），
      // 否则到达即绘制本身就已经很平滑，A/B 比不出东西。
      chunkIntervalMs: 25,
      idleProbability: 0.12,
      burstMinChars: 2,
      burstMaxChars: 120,
    });
    const scheduledChars = schedule.reduce((sum, entry) => sum + entry.text.length, 0);
    const documentText = buildAnswerDocument(Math.min(scheduledChars, STREAM_PREVIEW_MAX_CHARS));

    let cursor = 0;
    let propUpdates = 0;
    let visibleText = '';
    let pending = '';
    let flushTimer: number | null = null;
    let renderedAtHalf = 0;

    const flush = () => {
      if (pending.length === 0) {
        return;
      }
      const chunk = pending;
      pending = '';
      visibleText = appendPreview(visibleText, chunk);
      propUpdates += 1;
      setText(visibleText);
    };

    const chunks = schedule.map((entry) => {
      const size = Math.max(1, entry.text.length);
      const slice = documentText.slice(cursor, cursor + size);
      cursor += size;
      return { atMs: entry.atMs, text: slice };
    });

    const startedAt = performance.now();
    const cancel = pumpBurstySchedule(chunks, (chunk) => {
      // 复刻 agentStore：窗口起始立刻上一次屏，窗口内的后续 delta 合并成至多一次尾随 flush。
      pending += chunk;
      if (flushTimer === null) {
        flush();
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          flush();
        }, STORE_FLUSH_WINDOW_MS);
      }
    });

    const halfHandle = window.setTimeout(() => {
      renderedAtHalf = lastRenderedRef.current.length;
    }, Math.round(STREAM_TOTAL_MS / 2));

    const finishHandle = window.setTimeout(() => {
      cancel();
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();

      // 关键读数：流式**尚未结束**时，屏幕上真正有多少字。
      const renderedAtStreamEnd = lastRenderedRef.current.length;
      const storeTextAtStreamEnd = visibleText.length;

      cancelAnimationFrame(frameHandle);
      setStreaming(false);

      window.setTimeout(() => {
        longTaskObserver?.disconnect();
        const hookSnapshot = readAndResetSmoothness(performance.now());

        const stamps = visibleAtRef.current;
        const intervals: number[] = [];
        for (let index = 1; index < stamps.length; index += 1) {
          intervals.push(stamps[index] - stamps[index - 1]);
        }
        const chars = visibleCharsRef.current.slice(1);

        // 先固定测量窗口的读数，再做（可能很慢的）正确性回放自检，避免自检把 durationMs 撑大。
        const durationMs = Math.round(performance.now() - startedAt);
        const tailLexMismatches = verifyIncrementalBlocks(tailLexInputs);

        resolveProbe({
          arm,
          horizonMs: ARMS[arm].horizon,
          minFrameMs: ARMS[arm].minFrame,
          usesRevealHook: arm !== 'direct',
          durationMs,
          scheduledChars,
          documentChars: documentText.length,
          appendedChars: cursor,
          propUpdates,
          storeTextAtStreamEnd,
          renderedAtHalf,
          renderedAtStreamEnd,
          framesObserved,
          /** 增量分块的自检：`calls` 为 0 表示这条臂没有注入；`mismatches` 必须恒为 0。 */
          tailLex: { calls: tailLexInputs.length, mismatches: tailLexMismatches },
          /**
           * 结束时页面上 Shiki 输出的块数（`reveal-nocode` / `reveal-plain` 应为 0）。
           * 它同时是"延迟高亮"那条臂的自检：推迟之后必须真的高亮上了。
           */
          highlightedBlocks: document.querySelectorAll('[data-streaming-text="markdown"] .shiki').length,
          longTask: {
            count: longTasks.length,
            totalMs: longTasks.reduce((sum, entry) => sum + entry.durationMs, 0),
            maxMs: longTasks.reduce((max, entry) => Math.max(max, entry.durationMs), 0),
            /** 时间线：区分"首次初始化"与"每次提交都在做"的唯一直接证据。 */
            entries: longTasks,
          },
          profiler: { ...profilerTotals },
          visible: {
            updates: stamps.length,
            perSecond: intervals.length > 0
              ? (intervals.length * 1000) / (performance.now() - startedAt)
              : 0,
            intervalP50: percentile(intervals, 50),
            intervalP95: percentile(intervals, 95),
            charsPerUpdateCv: coefficientOfVariation(chars),
            charsPerUpdateMax: chars.reduce((max, value) => Math.max(max, value), 0),
          },
          /** hook 自己的读数：只覆盖分帧绘制出口，关闭后恒为空。 */
          hookSmoothness: hookSnapshot,
          pageErrors,
        });
      }, SETTLE_AFTER_STREAM_MS);
    }, STREAM_TOTAL_MS + 400);

    return () => {
      cancel();
      clearTimeout(halfHandle);
      clearTimeout(finishHandle);
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      cancelAnimationFrame(frameHandle);
      longTaskObserver?.disconnect();
    };
  }, [arm, warmReady]);

  return (
    <div
      ref={scrollerRef}
      id="probe-scroller"
      className="bg-background text-foreground"
      style={{ height: '100vh', overflowY: 'auto' }}
    >
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-4 text-ui-body text-muted-foreground">流式绘制探针 · {arm}</div>
        <Profiler
          id="probe-stream"
          onRender={(_id, _phase, actualDuration) => {
            profilerTotals.commits += 1;
            profilerTotals.totalMs += actualDuration;
            profilerTotals.maxMs = Math.max(profilerTotals.maxMs, actualDuration);
          }}
        >
          {arm === 'direct' ? (
            <DirectBubble
              text={text}
              streaming={streaming}
              onRenderedText={onRenderedText}
              onPinToBottom={onPinToBottom}
              plain={ARMS[arm].plain === true}
              noCode={ARMS[arm].noCode === true || (ARMS[arm].lazyCode === true && streaming)}
            />
          ) : (
            <RevealBubble
              text={text}
              streaming={streaming}
              onRenderedText={onRenderedText}
              onPinToBottom={onPinToBottom}
              plain={ARMS[arm].plain === true}
              noCode={ARMS[arm].noCode === true || (ARMS[arm].lazyCode === true && streaming)}
            />
          )}
        </Profiler>
      </div>
    </div>
  );
}

/**
 * 读取臂名。宿主的 query 键是 `mode`（与 transcript-probe 共用同一套 Electron 入口），
 * `arm` 作为本地直开页面时的别名一起接受。
 */
function readArm(): ArmName {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('mode') ?? params.get('arm');
  if (param && param in ARMS) {
    return param as ArmName;
  }
  return 'reveal-default';
}

const arm = readArm();
const config = ARMS[arm];
// 必须在挂载之前写：hook 读取的 horizon 是模块级缓存的。
window.localStorage.setItem(HORIZON_STORAGE_KEY, String(config.horizon));
window.localStorage.setItem(MIN_FRAME_STORAGE_KEY, String(config.minFrame));
resetRevealHorizonCache();

const container = document.getElementById('probe-root');
if (!container) {
  throw new Error('缺少 #probe-root');
}
createRoot(container).render(<Probe arm={arm} />);
