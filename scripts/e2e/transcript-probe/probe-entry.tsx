/**
 * 真实引擎探针的浏览器入口（无头 Chromium / Electron renderer）。
 *
 * 存在理由：`[data-long-thread] [data-message-row] { content-visibility: auto;
 * contain-intrinsic-size: auto 200px }` 的语义是「记住渲染过的真实高度，从未渲染过的
 * 行用 200px 占位」。左侧回合导航靠 `document.getElementById('msg-N')` +
 * `getBoundingClientRect()` 决定跳转落点，而 `id="msg-N"` 与 `data-message-row` 挂在
 * 同一个元素上——被跳过的元素自身被测量时，位置会建立在占位高度之上。这条推论只能在
 * 真实布局引擎里验证：jsdom 不实现相关 CSS（仓库既有契约测试也只在注释里承认了这一点）。
 *
 * 探针做的事：加载真实组件 + 真实构建样式表，装进 60 轮长会话夹具，停在底部（与真实
 * 打开长会话一致），然后走真实导航标记点击，量出落点残差
 * `target.getBoundingClientRect().top - container.getBoundingClientRect().top`
 * （`scrollToMessage` 的目标是 22px），并在两种状态下各测一次：
 *   - with-skip   ：现状，跳过规则生效；
 *   - without-skip：同一份 DOM，规则被运行器注入的 !important 覆盖中和。
 * 两侧的差值才是这条回归的大小——单看一侧无法区分「跳过导致偏差」与「跳转算法本身就不准」。
 *
 * 目标选择：`scrollToMessage` 的误差来自「目标行之上的行用占位高度替代真实高度」。
 * 因此**最早那条用户消息（turn 0）无法体现这条回归**：它之上没有任何行，残差只取决于
 * 容器自身的 20px 内边距（并且到顶时会被 scrollTop 的 0 边界截断）。探针因此把主目标
 * 定为「较早但不是第一条」的用户消息，同时把字面上「最早的一条」也测一遍作为对照，
 * 两个目标各自的读数都原样报出来，不做取舍。
 *
 * 工单 02 追加的诊断（默认开启，都不写 DOM、不改样式，也不改变结论行的形状——仍然是一行 JSON）：
 *   - 行高 / 代码块尺寸的时间线：用 ResizeObserver 只读观测（跳转动画正在跑，反复
 *     getBoundingClientRect 会强制同步布局、改变被测对象），每条变化带「相对点击时刻的
 *     毫秒偏移 + 行索引 + 变化前后高度 + 是否在目标之上 + 是否发生在动画落定之后」；
 *   - 代码块几何：Streamdown 会给每个 `[data-streamdown="code-block"]` 打上**内联**
 *     `content-visibility: auto; contain-intrinsic-size: auto 200px`——行内嵌着第二层
 *     跳过渲染，工单 01 的 !important 中和只覆盖 `[data-message-row]`，够不到它。
 *     每个采样行都带上它内部代码块的高度与相关性（checkVisibility contentVisibilityAuto）；
 *   - 字体时序：`document.fonts.status` / `fonts.ready` 解决时刻 / `loadingdone` 时刻 /
 *     已注册字体面（用来排除「UI 字体挂载后才生效」这条候选）；
 *   - React commit（`<Profiler>`）与 DOM 变更（MutationObserver）时间线，用来判断行高变化
 *     是否与一次异步模块到达 / 一次提交同时发生；
 *   - 口径自查：容器 border/padding/clientWidth/滚动条宽度前后是否一致、offsetTop 链与
 *     rect+scrollTop 两条独立路径算出的漂移是否一致、时间线上「目标行之上」的高度变化之和
 *     是否等于漂移。
 * 唯一会改变页面行为的是 `anchor=none`（由主进程从 CODEMUX_PROBE_ANCHOR 透传）：它把容器的
 * scroll anchoring 关掉，用来单独量「浏览器滚动锚定」这一条候选的贡献；默认不设置。
 */
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';

import { CodeMuxAssistantRuntimeProvider } from '@/components/agent/assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from '@/components/agent/assistant-ui/CodeMuxThread';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  buildLongSessionEvents,
  LONG_SESSION_EVENT_THRESHOLD,
  LONG_SESSION_ID,
  PROBE_TURN_COUNT,
  userMessageEventIndex,
} from '@/lib/dev/longSessionFixture';
import { useAgentStore } from '@/stores/agentStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Session } from '@/types/session';

/** `scrollToMessage` 的目标：让目标行落在容器顶下方 22px。 */
/** Streamdown 代码块根元素的标记：它自己带一层内联的内容可见性跳过。 */
const CODE_BLOCK_SELECTOR = '[data-streamdown="code-block"]';
const CODE_BLOCK_BODY_SELECTOR = '[data-streamdown="code-block-body"]';

/**
 * 代码块自己的占位高度 = 内联 `contain-intrinsic-size` 的值 + 上下边框。
 *
 * 必须加上边框：实测占位态的代码块 rect 是 202px（200 内容 + 2px 边框），直接拿 200 比会
 * 一个都数不出来——这正是第一版诊断犯过的错，也说明「用 rect 高度判占位态」必须按声明的
 * intrinsic size 加边框来算。
 */
function intrinsicPlaceholderHeight(style: CSSStyleDeclaration): number | null {
  const match = /(-?[\d.]+)px/.exec(style.containIntrinsicSize ?? '');
  if (!match) {
    return null;
  }
  const borderTopPx = Number.parseFloat(style.borderTopWidth) || 0;
  const borderBottomPx = Number.parseFloat(style.borderBottomWidth) || 0;
  return Number.parseFloat(match[1]) + borderTopPx + borderBottomPx;
}

/**
 * 一个代码块的几何事实。
 *
 * 只报行高无法区分「这行的 markdown 文本变矮了」与「这行里那个代码块占位终于被替换成真实
 * 高度了」，所以采样行必须带上内部代码块这一层：占位高度、是否正处在占位态，以及盒子内部
 * 的几何（正文相对盒子的位置、直接子元素）。
 */
type CodeBlockShape = {
  /** 代码块自身的布局高度：没有做过布局时等于「intrinsic size + 上下边框」。 */
  height: number;
  /** 按内联 contain-intrinsic-size 声明算出的占位高度。 */
  placeholderPx: number | null;
  /** 当前高度是否等于占位高度。 */
  atIntrinsicPlaceholder: boolean;
  /** `[data-streamdown="code-block-body"]` 的高度。 */
  bodyHeight: number | null;
  /**
   * 盒子的内部结构：判定「202px 是占位还是真实内容」的决定性读数。
   * 正文底边距盒子底边的距离若约等于 112px，说明这 112px 没有任何内容占着——那就是
   * contain-intrinsic-size 的占位。
   */
  bodyTopFromBlockTop: number | null;
  bodyBottomGap: number | null;
  /** 直接子元素的摘要（tag + 高度），用来确认盒子里到底有没有别的东西撑着高度。 */
  children: Array<{ tag: string; streamdownSlot: string | null; height: number }>;
  /** `checkVisibility({ contentVisibilityAuto: true })`：仅作对照（实测不可靠，见报告）。 */
  relevant: boolean | null;
  contentVisibility: string | null;
  containIntrinsicSize: string | null;
};

type RowSnapshot = {
  index: number;
  id: string | null;
  height: number;
  codeBlocks: CodeBlockShape[];
};

/** 读一个代码块的几何与内部结构（只读，用于采样）。 */
function describeCodeBlocks(row: Element): CodeBlockShape[] {
  return Array.from(row.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR)).map((block) => {
    const style = window.getComputedStyle(block);
    const blockRect = block.getBoundingClientRect();
    const height = Math.round(blockRect.height);
    const placeholderPx = intrinsicPlaceholderHeight(style);
    const body = block.querySelector<HTMLElement>(CODE_BLOCK_BODY_SELECTOR);
    const bodyRect = body ? body.getBoundingClientRect() : null;
    return {
      height,
      placeholderPx,
      atIntrinsicPlaceholder: placeholderPx != null && Math.abs(height - placeholderPx) <= 0.75,
      bodyHeight: bodyRect ? Math.round(bodyRect.height) : null,
      bodyTopFromBlockTop: bodyRect ? Math.round(bodyRect.top - blockRect.top) : null,
      bodyBottomGap: bodyRect ? Math.round(blockRect.bottom - bodyRect.bottom) : null,
      children: Array.from(block.children).slice(0, 6).map((child) => ({
        tag: child.tagName,
        streamdownSlot: child.getAttribute('data-streamdown'),
        height: Math.round(child.getBoundingClientRect().height),
      })),
      relevant: checkVisibility(block),
      contentVisibility: style.contentVisibility ?? null,
      containIntrinsicSize: style.containIntrinsicSize ?? null,
    };
  });
}

/** 行快照：跳转前后各取一次，除行高外还带上行内代码块那一层的几何。 */
function snapshotRows(): RowSnapshot[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]')).map((row, index) => ({
    index,
    id: row.id || null,
    height: Math.round(row.getBoundingClientRect().height),
    codeBlocks: describeCodeBlocks(row),
  }));
}

type RowHeightChange = {
  index: number;
  id: string | null;
  before: number;
  after: number;
  delta: number;
  codeBlocksBefore: CodeBlockShape[];
  codeBlocksAfter: CodeBlockShape[];
};

type RowHeightChanges = {
  /** 改动过的行总数（不受 changes 数组上限影响）。 */
  changedRowCount: number;
  /** 目标行之上改动过的行数。 */
  changedRowsAboveTarget: number;
  /** 目标行之上、且这次变化确实伴随「代码块从 200px 占位变成别的尺寸」的行数。 */
  codeBlockPlaceholderFlipCountAboveTarget: number;
  /** 目标行之上所有行高变化之和（正 = 内容变高，把目标行往下推）。 */
  sumAboveTargetPx: number;
  /** 目标行及其下方所有行高变化之和。 */
  sumBelowTargetPx: number;
  changes: RowHeightChange[];
};

function diffRows(
  before: RowSnapshot[],
  after: RowSnapshot[],
  targetRowIndex: number,
): RowHeightChanges {
  const changes: RowHeightChange[] = [];
  const length = Math.min(before.length, after.length);
  let sumAboveTargetPx = 0;
  let sumBelowTargetPx = 0;
  let changedRowCount = 0;
  let changedRowsAboveTarget = 0;
  let codeBlockPlaceholderFlipCountAboveTarget = 0;

  for (let index = 0; index < length; index += 1) {
    const previous = before[index];
    const current = after[index];
    const delta = (current?.height ?? 0) - (previous?.height ?? 0);
    if (delta === 0) {
      continue;
    }
    changedRowCount += 1;
    if (index < targetRowIndex) {
      sumAboveTargetPx += delta;
      changedRowsAboveTarget += 1;
      const placeholderBefore = (previous?.codeBlocks ?? [])
        .filter((block) => block.atIntrinsicPlaceholder).length;
      const placeholderAfter = (current?.codeBlocks ?? [])
        .filter((block) => block.atIntrinsicPlaceholder).length;
      if (placeholderBefore > placeholderAfter) {
        codeBlockPlaceholderFlipCountAboveTarget += 1;
      }
    } else {
      sumBelowTargetPx += delta;
    }
    if (changes.length < 40) {
      changes.push({
        index,
        id: current?.id ?? null,
        before: previous?.height ?? 0,
        after: current?.height ?? 0,
        delta,
        codeBlocksBefore: previous?.codeBlocks ?? [],
        codeBlocksAfter: current?.codeBlocks ?? [],
      });
    }
  }

  return {
    changedRowCount,
    changedRowsAboveTarget,
    codeBlockPlaceholderFlipCountAboveTarget,
    sumAboveTargetPx,
    sumBelowTargetPx,
    changes,
  };
}

const EXPECTED_RESIDUAL_PX = 22;
/** 夹具里 `contain-intrinsic-size` 的占位高度：未被渲染过的行就长这样。 */
const PLACEHOLDER_HEIGHT_PX = 200;
/**
 * 主目标轮次：必须落在「挂载时没有被渲染过」的行区间之内。
 * 实测（无头 Electron 33 / 1280x900 / 60 轮夹具）：挂载后 0..15 行已有真实高度，
 * 16..162 行仍是 200px 占位，163..179 行是底部可见区。turn 5 的目标行正好是第 15 行，
 * 目标之上一个占位行都没有——那样的目标量不出累计偏移。turn 12 落在占位区中间。
 */
const PRIMARY_TARGET_TURN = 12;
/** 字面意义上的「最早的一条用户消息」，作为对照目标。 */
const LITERAL_EARLIEST_TURN = 0;
/** 轮询间隔：不依赖 rAF 频率（无头窗口下 rAF 约 1fps，重布局期间更慢）。 */
const TICK_MS = 32;
/** 落定判据：scrollTop 在这段时间内不再变化。 */
const SCROLL_STABLE_MS = 700;
/** 点击后等第一次滚动出现的最长时间（无头窗口下首个动画帧可能 1s 后才到）。 */
const CLICK_SCROLL_DEADLINE_MS = 8_000;
const SCROLL_MIN_TICKS = 8;
const SCROLL_SETTLE_TIMEOUT_MS = 60_000;
/** 布局静下来的判据：scrollHeight 与 scrollTop 都不变这么久。 */
const LAYOUT_STABLE_MS = 2_000;
const LAYOUT_SETTLE_TIMEOUT_MS = 30_000;
const ROWS_STABLE_MS = 600;
const MOUNT_TIMEOUT_MS = 90_000;
const ROWS_SETTLE_TIMEOUT_MS = 60_000;

/** 容器盒模型 / 字体的快照：漂移口径里含容器 border+padding 这一常量项，必须能证明它前后一致。 */
type ContainerBox = {
  borderTopPx: number;
  paddingTopPx: number;
  clientWidthPx: number;
  offsetWidthPx: number;
  /** offsetWidth 减 clientWidth（再去掉左右边框）：出现 / 消失会改变内容宽度，进而改行高。 */
  verticalScrollbarPx: number;
  overflowAnchor: string;
  overflowY: string;
  fontFamily: string;
  fontSize: string;
};

function describeContainerBox(container: HTMLElement): ContainerBox {
  const style = window.getComputedStyle(container);
  const borderLeftPx = Number.parseFloat(style.borderLeftWidth) || 0;
  return {
    borderTopPx: Number.parseFloat(style.borderTopWidth) || 0,
    paddingTopPx: Number.parseFloat(style.paddingTop) || 0,
    clientWidthPx: container.clientWidth,
    offsetWidthPx: container.offsetWidth,
    verticalScrollbarPx: container.offsetWidth - container.clientWidth - borderLeftPx * 2,
    overflowAnchor: style.overflowAnchor ?? '',
    overflowY: style.overflowY ?? '',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
  };
}

/**
 * 口径自查的第二条独立路径：沿 offsetTop / offsetParent 链累加目标行的位置。
 *
 * 它与 `rect.top + scrollTop` 的口径相差一个固定的 border+padding 常量，而常量在**差值**里
 * 会抵消，所以两条路径算出的漂移必须一致；不一致说明漂移里有口径伪影（例如容器 padding
 * 在两次测量之间变了）。offsetParent 链不落在容器上时返回 null，表示这条路径不可用。
 */
function measureDocTopViaOffsetChain(target: HTMLElement, container: HTMLElement): number | null {
  let node: HTMLElement | null = target;
  let total = 0;
  let hops = 0;
  while (node && node !== container && hops < 64) {
    total += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
    hops += 1;
  }
  return node === container ? total : null;
}

type FrameSample = {
  /** 相对点击时刻的毫秒偏移。 */
  tFromClick: number;
  scrollTop: number;
  scrollHeight: number;
  fontsStatus: string;
  commitCount: number;
  mutationCount: number;
};

type LayoutTimelineChange = {
  kind: 'row' | 'code-block';
  t: number;
  /** 相对点击时刻的毫秒偏移；点击之前为 null。 */
  tFromClick: number | null;
  /** 行索引（code-block 时是它所属行的索引）。 */
  index: number;
  id: string | null;
  from: number;
  to: number;
  delta: number;
  aboveTarget: boolean | null;
  /** 该变化发生在平滑滚动落定之后（落定后再变 = 直接改残差）。 */
  afterAnimationSettled: boolean;
};

type FlightTimeline = {
  clickedAtMs: number | null;
  settledAtMs: number | null;
  targetRowIndex: number | null;
  changeCount: number;
  droppedChanges: number;
  /** 目标行之上、跳转途中的行高变化之和（ResizeObserver 口径）。 */
  sumAboveTargetRowPx: number;
  /** 目标行之上的代码块尺寸变化之和（200px 占位被替换的净效果）。 */
  sumAboveTargetCodeBlockPx: number;
  changes: LayoutTimelineChange[];
  frames: FrameSample[];
  fontLoadingDoneAtMs: number[];
  fontsReadyAtMs: number | null;
};

type MutationSummary = {
  t: number;
  tFromClick: number | null;
  type: string;
  attributeName: string | null;
  tagName: string | null;
  rowIndex: number | null;
  addedNodes: number;
  removedNodes: number;
};

type FontDiagnostics = {
  statusAtStart: string;
  statusBeforeClick: string;
  statusAfterSettle: string;
  /** `document.fonts.ready` 解决的时刻（performance.now()）；没有任何网络字体时也会很快解决。 */
  readyAtMs: number | null;
  /** `loadingdone` 事件时刻：字体真正换上的时刻。空数组 = 这次运行里没有字体换装。 */
  loadingDoneAtMs: number[];
  faceCount: number;
  faces: Array<{ family: string; weight: string; style: string; status: string }>;
  facesTruncated: boolean;
};

const LAYOUT_TIMELINE_CAP = 240;
const FRAME_SAMPLE_CAP = 400;
const COMMIT_TIMELINE_CAP = 400;
const MUTATION_TIMELINE_CAP = 160;

const fontTimeline: FontDiagnostics = {
  statusAtStart: '',
  statusBeforeClick: '',
  statusAfterSettle: '',
  readyAtMs: null,
  loadingDoneAtMs: [],
  faceCount: 0,
  faces: [],
  facesTruncated: false,
};

const commitTimeline = {
  count: 0,
  dropped: 0,
  entries: [] as Array<{ t: number; tFromClick: number | null; phase: string }>,
};

const mutationTimeline = {
  count: 0,
  dropped: 0,
  entries: [] as MutationSummary[],
};

const layoutTimeline = {
  clickedAtMs: null as number | null,
  settledAtMs: null as number | null,
  targetRowIndex: null as number | null,
  changes: [] as LayoutTimelineChange[],
  droppedChanges: 0,
  frames: [] as FrameSample[],
  rowHeights: new Map<Element, number>(),
  rowIndexes: new Map<Element, number>(),
  blockHeights: new Map<Element, number>(),
  blockRowIndexes: new Map<Element, number>(),
  rowObserver: null as ResizeObserver | null,
  blockObserver: null as ResizeObserver | null,
  sampling: false,
};

/** 把元素映射回它所属的消息行索引（MutationObserver / commit 归因用）。 */
function rowIndexOf(element: Element | null): number | null {
  let node: Element | null = element;
  let hops = 0;
  while (node && hops < 64) {
    const index = layoutTimeline.rowIndexes.get(node);
    if (index != null) {
      return index;
    }
    node = node.parentElement;
    hops += 1;
  }
  return null;
}

function indexRows(): void {
  layoutTimeline.rowIndexes.clear();
  layoutTimeline.blockRowIndexes.clear();
  Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]')).forEach((row, index) => {
    layoutTimeline.rowIndexes.set(row, index);
    for (const block of Array.from(row.querySelectorAll(CODE_BLOCK_SELECTOR))) {
      layoutTimeline.blockRowIndexes.set(block, index);
    }
  });
}

function stopLayoutObservation(): void {
  layoutTimeline.rowObserver?.disconnect();
  layoutTimeline.blockObserver?.disconnect();
  layoutTimeline.rowObserver = null;
  layoutTimeline.blockObserver = null;
}

/**
 * 布下只读的尺寸观测。用 ResizeObserver 而不是「每帧读一遍 180 行的 rect」：探针是在平滑
 * 滚动动画进行中采样的，反复强制同步布局会改变被测对象本身；RO 在布局之后回调，不介入
 * 布局，又能拿到每个元素精确的变化时刻。第一次回调只当基线，不记成变化。
 */
function startLayoutObservation(): void {
  stopLayoutObservation();
  indexRows();
  layoutTimeline.rowObserver = new ResizeObserver((entries) => collectLayoutChanges('row', entries));
  layoutTimeline.blockObserver = new ResizeObserver((entries) => collectLayoutChanges('code-block', entries));
  for (const row of layoutTimeline.rowIndexes.keys()) {
    layoutTimeline.rowObserver.observe(row);
    for (const block of Array.from(row.querySelectorAll(CODE_BLOCK_SELECTOR))) {
      layoutTimeline.blockObserver.observe(block);
    }
  }
}

function collectLayoutChanges(kind: 'row' | 'code-block', entries: ResizeObserverEntry[]): void {
  const heights = kind === 'row' ? layoutTimeline.rowHeights : layoutTimeline.blockHeights;
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    const height = Math.round(box ? box.blockSize : entry.contentRect.height);
    const previous = heights.get(entry.target);
    heights.set(entry.target, height);
    if (previous === undefined || previous === height) {
      continue;
    }
    const clickedAtMs = layoutTimeline.clickedAtMs;
    if (clickedAtMs == null) {
      // 点击之前的变化不算这次跳转的账；基线由 snapshotRows() 取。
      continue;
    }
    const index = kind === 'row'
      ? layoutTimeline.rowIndexes.get(entry.target) ?? null
      : layoutTimeline.blockRowIndexes.get(entry.target) ?? null;
    if (index == null) {
      continue;
    }
    if (layoutTimeline.changes.length >= LAYOUT_TIMELINE_CAP) {
      layoutTimeline.droppedChanges += 1;
      continue;
    }
    const now = performance.now();
    layoutTimeline.changes.push({
      kind,
      t: now,
      tFromClick: now - clickedAtMs,
      index,
      id: kind === 'row' ? ((entry.target as HTMLElement).id || null) : null,
      from: previous,
      to: height,
      delta: height - previous,
      aboveTarget: layoutTimeline.targetRowIndex == null ? null : index < layoutTimeline.targetRowIndex,
      afterAnimationSettled: layoutTimeline.settledAtMs != null,
    });
  }
}

/** 与滚动采样同节奏记录现场（只读 scrollTop/scrollHeight/fonts.status），用于把变化对上时间。 */
async function sampleFramesUntilStopped(container: HTMLElement): Promise<void> {
  layoutTimeline.sampling = true;
  while (layoutTimeline.sampling) {
    await nextTick();
    const clickedAtMs = layoutTimeline.clickedAtMs;
    if (clickedAtMs == null || layoutTimeline.frames.length >= FRAME_SAMPLE_CAP) {
      continue;
    }
    layoutTimeline.frames.push({
      tFromClick: Math.round(performance.now() - clickedAtMs),
      scrollTop: Math.round(container.scrollTop),
      scrollHeight: container.scrollHeight,
      fontsStatus: document.fonts.status,
      commitCount: commitTimeline.count,
      mutationCount: mutationTimeline.count,
    });
  }
}

/** 记下点击时刻：时间线上所有偏移都以它为原点；同时清掉上一次测量的账。 */
function beginFlight(targetRowIndex: number): void {
  layoutTimeline.clickedAtMs = performance.now();
  layoutTimeline.settledAtMs = null;
  layoutTimeline.targetRowIndex = targetRowIndex;
  layoutTimeline.changes.length = 0;
  layoutTimeline.droppedChanges = 0;
  layoutTimeline.frames.length = 0;
  fontTimeline.statusBeforeClick = document.fonts.status;
}

/** 落定时刻：之后发生的尺寸变化会直接改落点，单独标出来。 */
function markFlightSettled(): void {
  layoutTimeline.settledAtMs = performance.now();
  fontTimeline.statusAfterSettle = document.fonts.status;
}

function snapshotFlightTimeline(): FlightTimeline {
  const rowChanges = layoutTimeline.changes.filter((change) => change.kind === 'row');
  return {
    clickedAtMs: layoutTimeline.clickedAtMs,
    settledAtMs: layoutTimeline.settledAtMs,
    targetRowIndex: layoutTimeline.targetRowIndex,
    changeCount: layoutTimeline.changes.length,
    droppedChanges: layoutTimeline.droppedChanges,
    sumAboveTargetRowPx: rowChanges
      .filter((change) => change.aboveTarget === true)
      .reduce((sum, change) => sum + change.delta, 0),
    sumAboveTargetCodeBlockPx: layoutTimeline.changes
      .filter((change) => change.kind === 'code-block' && change.aboveTarget === true)
      .reduce((sum, change) => sum + change.delta, 0),
    changes: [...layoutTimeline.changes],
    frames: [...layoutTimeline.frames],
    fontLoadingDoneAtMs: [...fontTimeline.loadingDoneAtMs],
    fontsReadyAtMs: fontTimeline.readyAtMs,
  };
}

/**
 * 字体时序。本仓库有「内置默认字体 + 外观字体加载」的改动：若 UI 字体在挂载之后才换上，
 * 文本度量会整体变化、行高成片改变。这条候选必须用 fonts 的状态与时刻排除掉。
 */
function startFontObservation(): void {
  fontTimeline.statusAtStart = document.fonts.status;
  fontTimeline.faceCount = document.fonts.size;
  fontTimeline.facesTruncated = document.fonts.size > 24;
  fontTimeline.faces = Array.from(document.fonts).slice(0, 24).map((face) => ({
    family: face.family,
    weight: face.weight,
    style: face.style,
    status: face.status,
  }));
  document.fonts.addEventListener('loadingdone', () => {
    fontTimeline.loadingDoneAtMs.push(performance.now());
  });
  void document.fonts.ready.then(() => {
    fontTimeline.readyAtMs = performance.now();
  });
}

function recordCommit(phase: string): void {
  commitTimeline.count += 1;
  if (commitTimeline.entries.length >= COMMIT_TIMELINE_CAP) {
    commitTimeline.dropped += 1;
    return;
  }
  const clickedAtMs = layoutTimeline.clickedAtMs;
  const now = performance.now();
  commitTimeline.entries.push({
    t: now,
    tFromClick: clickedAtMs == null ? null : now - clickedAtMs,
    phase,
  });
}

/** DOM 变更时间线：判断行高变化是否与一次「异步模块到达 / 提交换树」同时发生。 */
function startMutationObservation(container: HTMLElement): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      mutationTimeline.count += 1;
      if (mutationTimeline.entries.length >= MUTATION_TIMELINE_CAP) {
        mutationTimeline.dropped += 1;
        continue;
      }
      const clickedAtMs = layoutTimeline.clickedAtMs;
      const now = performance.now();
      const mutationTarget = record.target as Element;
      mutationTimeline.entries.push({
        t: now,
        tFromClick: clickedAtMs == null ? null : now - clickedAtMs,
        type: record.type,
        attributeName: record.attributeName ?? null,
        tagName: mutationTarget.tagName ?? null,
        rowIndex: rowIndexOf(mutationTarget),
        addedNodes: record.addedNodes.length,
        removedNodes: record.removedNodes.length,
      });
    }
  });
  observer.observe(container, {
    subtree: true,
    attributes: true,
    childList: true,
    characterData: true,
  });
  return observer;
}

/**
 * 代码块会计：行内嵌着的那一层跳过渲染（Streamdown 给每个代码块打的内联
 * `content-visibility: auto; contain-intrinsic-size: auto 200px`）里，还有多少代码块没有做过
 * 布局、因此仍以「intrinsic size + 边框」参与文档高度。目标行之上的这些占位就是残差的直接来源：
 * 每个这样的代码块一旦被布局，高度会从约 202px 掉到约 90px，把它下面的所有行整体上提 112.5px。
 */
function collectCodeBlockAccounting(rows: HTMLElement[], targetIndex: number): CodeBlockAccounting {
  let total = 0;
  let intrinsicPlaceholderCount = 0;
  let placeholderBodyCollapsedCount = 0;
  let skippedCount = 0;
  let aboveTargetIntrinsicPlaceholderCount = 0;
  let aboveTargetIntrinsicPlaceholderPx = 0;

  rows.forEach((row, index) => {
    for (const block of describeCodeBlocks(row)) {
      total += 1;
      if (block.atIntrinsicPlaceholder) {
        intrinsicPlaceholderCount += 1;
        // 占位态的第二个判据：子树没有参与布局，正文元素的高度塌成 0。
        if (block.bodyHeight === 0) {
          placeholderBodyCollapsedCount += 1;
        }
        if (index < targetIndex) {
          aboveTargetIntrinsicPlaceholderCount += 1;
          aboveTargetIntrinsicPlaceholderPx += block.height;
        }
      }
      if (block.relevant === false) {
        skippedCount += 1;
      }
    }
  });

  return {
    selector: CODE_BLOCK_SELECTOR,
    total,
    intrinsicPlaceholderCount,
    placeholderBodyCollapsedCount,
    skippedCount,
    aboveTargetIntrinsicPlaceholderCount,
    aboveTargetIntrinsicPlaceholderPx,
  };
}

type ProbeMode = 'with-skip' | 'without-skip';
type NavPath = 'nav-marker-click' | 'dom-fallback';

/**
 * 行内嵌着的那一层跳过渲染的会计（Streamdown 代码块自己的内联 content-visibility）。
 * 目标行之上的 `aboveTargetIntrinsicPlaceholderCount` 就是残差的直接来源：每个这样的代码块
 * 用约 202px 占位代替约 90px 的真实高度，一旦被布局就把目标行整体上提 112.5px。
 */
type CodeBlockAccounting = {
  selector: string;
  total: number;
  /** 高度等于「声明占位高度 + 边框」= 没有做过布局的代码块数。 */
  intrinsicPlaceholderCount: number;
  /** 其中正文元素高度为 0 的个数：占位态下子树不参与布局的硬证据。 */
  placeholderBodyCollapsedCount: number;
  /** 被 checkVisibility({contentVisibilityAuto}) 判为不相关的代码块数（读数不可靠，仅对照）。 */
  skippedCount: number;
  aboveTargetIntrinsicPlaceholderCount: number;
  aboveTargetIntrinsicPlaceholderPx: number;
};

type RowDiagnostics = {
  totalRowCount: number;
  /** 高度等于 200px 占位高度的行数：跳过规则确实参与布局的证据。 */
  placeholderRowCount: number;
  firstPlaceholderRowIndex: number | null;
  lastPlaceholderRowIndex: number | null;
  targetRowIndex: number;
  /** 目标行之上的占位行数——这条回归的全部杠杆都在这里。 */
  placeholderRowsAboveTarget: number;
  /** 行内那一层跳过渲染（Streamdown 代码块）的会计。 */
  codeBlocks: CodeBlockAccounting;
  samples: Array<{
    index: number;
    id: string | null;
    height: number | null;
    checkVisibility: boolean | null;
    codeBlocks: CodeBlockShape[];
  }>;
};

type TargetMeasurement = {
  targetId: string;
  /** 目标所属轮次，与夹具的 userMessageEventIndex 对应。 */
  targetTurn: number;
  targetSelector: string;
  /** 起点在底部时目标行是否仍处于「未被渲染」状态（高度等于占位高度）。 */
  targetWasSkippedBeforeClick: boolean;
  /** 跳转途中改过高度的行（最多 40 条）：区分「占位高度被替换」与「异步渲染补齐」。 */
  rowHeightChanges: RowHeightChanges;
  navPath: NavPath;
  navMarkerIndex: number;
  navMarkerLabel: string | null;
  /** 点击前目标行的布局高度：占位高度为 200px，真实用户行远小于此。 */
  targetHeightBeforeClickPx: number;
  /** 点击后目标行的真实高度（渲染过后）。 */
  targetHeightAfterSettlePx: number;
  /** checkVisibility({contentVisibilityAuto}) 的读数，仅作对照记录。 */
  targetCheckVisibilityBeforeClick: boolean | null;
  /** 点击前的行布局诊断（哪些行还在占位高度上、其中有多少在目标行之上）。 */
  rowDiagnostics: RowDiagnostics;
  /** 点击前布局已经静下来的时长，以及是否因超时而放弃等待。 */
  layoutStableMs: number;
  layoutSettleTimedOut: boolean;
  /**
   * 残差分解：residualPx ≈ 22 + targetDocTopDriftPx − scrollTopErrorPx。
   * 布局漂移是「目标行上方内容高度在跳转过程中变了」，滚动误差是「动画没落到请求的位置」。
   */
  estimatedOffsetTopPx: number;
  requestedScrollTopPx: number;
  scrollTopErrorPx: number;
  targetDocTopBeforePx: number;
  targetDocTopAfterPx: number;
  targetDocTopDriftPx: number;
  scrollHeightBeforeClickPx: number;
  scrollHeightAfterSettlePx: number;
  scrollHeightDeltaPx: number;
  /** 目标行上的计算样式：用于确认 without-skip 那一侧确实把规则中和掉了。 */
  computedContentVisibility: string | null;
  computedContainIntrinsicSize: string | null;
  /** 高度为 0 的行数：中和若只摘掉占位高度而没摘跳过，行会塌成 0。 */
  rowCountWithZeroHeight: number;
  /** 点击是否真的产生了滚动（无头窗口下平滑滚动约 1 帧之后才推进）。 */
  scrollStarted: boolean;
  scrollTopBeforeClick: number;
  scrollTopAfterSettle: number;
  /** 点击后的滚动轨迹（按变化采样）；无头窗口下 rAF 约 1fps，轨迹是判断「测到的是落点还是动画中途」的依据。 */
  settleTrajectory: Array<{ t: number; scrollTop: number; scrollHeight: number }>;
  scrollHeightPx: number;
  clientHeightPx: number;
  settleTicks: number;
  settleStableMs: number;
  settleTimedOut: boolean;
  /** 落点残差：target.top - container.top。落点正确 ⇒ 约等于 22。 */
  residualPx: number;
  expectedResidualPx: number;
  elapsedMs: number;
  /** 口径自查：容器自身盒模型 / 字体在跳转前后是否一致（不一致则漂移口径失真）。 */
  containerBoxBefore: ContainerBox;
  containerBoxAfter: ContainerBox;
  /** 口径自查：offsetTop 链算出的目标行位置（与 rect+scrollTop 口径差一个常量）。 */
  docTopViaOffsetChainBeforePx: number | null;
  docTopViaOffsetChainAfterPx: number | null;
  docTopDriftViaOffsetChainPx: number | null;
  /** 口径自查：漂移 与「目标行之上行高变化之和」的差（应约等于 0）。 */
  driftVsSumAboveTargetPx: number;
  /** 口径自查：漂移 与「时间线上目标行之上的行高变化之和」的差（两条独立测量路径）。 */
  driftVsTimelineSumAbovePx: number | null;
  /** 目标行这个 DOM 节点在两次测量之间是否同一个（换了节点则两次测量不可比）。 */
  targetNodeStable: boolean;
  /** 落定后目标行上下各 6 行的行高与代码块几何：跳转结束后还有哪些行停在占位上。 */
  postSettleRows: RowSnapshot[];
  /** 行高 / 代码块尺寸变化的时间线（相对点击时刻）。 */
  flightTimeline: FlightTimeline;
  fontsStatusBeforeClick: string;
  fontsStatusAfterSettle: string;
};

type ProbeResult = {
  probe: 'codemux-transcript-probe';
  mode: ProbeMode;
  turnCount: number;
  eventCount: number;
  totalRowCount: number;
  /** 组件是否给对话区打了 data-long-thread（生产判定：事件数 > 120）。 */
  longThreadAttrPresent: boolean;
  /** 运行器是否用 !important 覆盖中和了跳过规则。 */
  neutralizedByCss: boolean;
  /** 点击前是否停在底部（偏差应约等于 0）。 */
  initialBottomOffsetPx: number;
  /** 主目标读数（较早但不是第一条的用户消息）。 */
  primary: TargetMeasurement;
  /** 对照目标读数（字面上最早的一条用户消息；在主目标之后测量，因此状态是热的）。 */
  literalEarliest: TargetMeasurement;
  /** 采样窗口内观察到的帧率（Hz）：无头窗口会把它压到 ~1-2Hz，而 60Hz 才是生产里平滑滚动的条件。 */
  rafRateHz: number;
  /** 运行器使用的窗口模式：headless（show:false）或 offscreen（showInactive 到屏幕外）。 */
  windowMode: string;
  pageErrors: string[];
  durationMs: number;
  /** 运行器是否用 !important 覆盖中和了「行级」跳过规则；行内代码块那一层不受它影响。 */
  anchorOverride: string | null;
  /** 挂载后容器的盒模型与字体：口径自查的基线。 */
  containerBoxAfterMount: ContainerBox;
  fonts: FontDiagnostics;
  /** React commit 时间线（`<Profiler>`）。 */
  commits: { count: number; dropped: number; entries: Array<{ t: number; tFromClick: number | null; phase: string }> };
  /** DOM 变更时间线（MutationObserver）。 */
  mutations: { count: number; dropped: number; entries: MutationSummary[] };
};

declare global {
  interface Window {
    __CODEMUX_TRANSCRIPT_PROBE__?: {
      promise: Promise<ProbeResult>;
      errors: string[];
      mode: ProbeMode;
    };
  }
}

const pageErrors: string[] = [];
const collectError = (message: string) => {
  if (!pageErrors.includes(message)) {
    pageErrors.push(message);
  }
};

window.addEventListener('error', (event) => {
  collectError(`error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  collectError(`unhandledrejection: ${String(event.reason)}`);
});

/**
 * 把共享长会话夹具装进真实 store——与真实打开一条长会话等价：
 * 事件数超过长会话阈值，因此组件会自己打上 data-long-thread。
 */
function primeStores(): void {
  const events = buildLongSessionEvents(PROBE_TURN_COUNT);

  useAgentStore.setState((state) => ({
    ...state,
    events: { ...state.events, [LONG_SESSION_ID]: events },
    eventTimestamps: {
      ...state.eventTimestamps,
      [LONG_SESSION_ID]: events.map((_, index) => index + 1),
    },
    isRunning: { ...state.isRunning, [LONG_SESSION_ID]: false },
    forceStopped: { ...state.forceStopped, [LONG_SESSION_ID]: false },
  }));

  const session: Session = {
    id: LONG_SESSION_ID,
    title: 'transcript probe',
    agent_kind: 'claude_code',
    provider_id: null,
    model: null,
    mode: 'agent',
    project_id: null,
    created_at: '',
    updated_at: '',
  };

  useSessionStore.setState((state) => ({
    ...state,
    sessions: [session],
    archivedSessions: [],
    activeSessionId: LONG_SESSION_ID,
    isLoading: false,
    error: null,
  }));

  useSettingsStore.setState((state) => ({
    ...state,
    config: {
      providers: [],
      active_provider_id: null,
      agent_defaults: { default_agent_kind: 'claude_code' },
      agent_configs: { claude_code: {}, codex: {}, gemini_cli: {}, opencode: {} },
      theme: 'System',
      compact_ai_output: false,
      default_open_target: 'file_explorer',
    },
  }));
}

const mode = (new URLSearchParams(window.location.search).get('mode') ?? 'with-skip') as ProbeMode;

/** 一次轮询：谁先到用谁（rAF 或 32ms），保证重布局期间仍然按固定节奏采样。 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, TICK_MS);
    window.requestAnimationFrame(done);
  });
}

/**
 * 采样帧率。无头窗口（show:false）下 Chromium 把 rAF 压到 ~1-2Hz，平滑滚动会「瞬移」；
 * 只有动画逐帧推进时，目标行之上的早期行才会被途经渲染——那正是这条回归的触发条件。
 * 帧率是判断一次运行算不算有效测量的前提，所以必须随结论一起报出来。
 */
async function measureRafRate(sampleMs = 700): Promise<number> {
  let frames = 0;
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      frames += 1;
      if (performance.now() - startedAt >= sampleMs) {
        resolve();
        return;
      }
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  });
  const elapsedMs = performance.now() - startedAt;
  return Math.round((frames / elapsedMs) * 1000 * 10) / 10;
}

async function tick(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextTick();
  }
}

async function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  const startedAt = performance.now();
  for (;;) {
    const element = document.querySelector<T>(selector);
    if (element) {
      return element;
    }
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`等待元素超时：${selector}（页面报错：${pageErrors.join(' | ') || '无'}）`);
    }
    await tick(2);
  }
}

/** 等消息行数量稳定下来，避免在 React 还在逐帧提交时测量。 */
async function waitForStableRowCount(container: HTMLElement): Promise<number> {
  const startedAt = performance.now();
  let lastCount = -1;
  let lastChangeAt = performance.now();

  for (;;) {
    await nextTick();
    const count = container.querySelectorAll('[data-message-row]').length;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = performance.now();
    }
    const now = performance.now();
    if (lastCount > 0 && now - lastChangeAt >= ROWS_STABLE_MS) {
      return lastCount;
    }
    if (now - startedAt > ROWS_SETTLE_TIMEOUT_MS) {
      throw new Error(`消息行数量长时间不稳定（当前 ${lastCount} 行）`);
    }
  }
}

function scrollState(container: HTMLElement) {
  return {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    bottomOffset: container.scrollHeight - container.clientHeight - container.scrollTop,
  };
}

/**
 * 等滚动落定。
 *
 * 判据是「scrollTop 与 scrollHeight 都静下来」：`content-visibility: auto` 会让行在被渲染的
 * 那一刻从 200px 占位变成真实高度（内容高度随之变化），只看 scrollTop 会在布局还在变时误判收敛。
 *
 * `collectTrajectory` 打开时按变化采样轨迹——无头窗口下 rAF 约 1fps，看不到轨迹就无法判断
 * 测到的是落点还是动画中途。
 */
async function waitForScrollSettle(
  container: HTMLElement,
  options: { expectChange?: boolean; collectTrajectory?: boolean } = {},
) {
  const expectChange = options.expectChange ?? false;
  const startedAt = performance.now();
  let lastScrollTop = container.scrollTop;
  let lastScrollHeight = container.scrollHeight;
  let lastChangeAt = performance.now();
  let changed = false;
  let ticks = 0;
  const trajectory: Array<{ t: number; scrollTop: number; scrollHeight: number }> = [];

  for (;;) {
    await nextTick();
    ticks += 1;
    const now = performance.now();
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    if (Math.abs(scrollTop - lastScrollTop) >= 0.01 || scrollHeight !== lastScrollHeight) {
      changed = true;
      lastScrollTop = scrollTop;
      lastScrollHeight = scrollHeight;
      lastChangeAt = now;
      if (options.collectTrajectory && trajectory.length < 120) {
        trajectory.push({ t: Math.round(now - startedAt), scrollTop: Math.round(scrollTop), scrollHeight });
      }
    }
    const stableMs = now - lastChangeAt;
    if ((!expectChange || changed) && ticks >= SCROLL_MIN_TICKS && stableMs >= SCROLL_STABLE_MS) {
      return { ticks, stableMs, timedOut: false, scrollTop, trajectory };
    }
    if (now - startedAt > SCROLL_SETTLE_TIMEOUT_MS) {
      return { ticks, stableMs, timedOut: true, scrollTop, trajectory };
    }
  }
}

/**
 * 等布局真正静下来：scrollHeight 与 scrollTop 都稳定。
 *
 * 挂载后的 markdown/高亮是异步补齐的，代码块会在首帧之后改变行高；带着还在变的布局去点导航，
 * 会把「异步渲染」的误差算进落点残差里，污染结论。所以每次跳转前都要等布局静下来。
 */
async function waitForLayoutSettled(
  container: HTMLElement,
): Promise<{ stableMs: number; timedOut: boolean }> {
  const startedAt = performance.now();
  let lastHeight = container.scrollHeight;
  let lastTop = container.scrollTop;
  let lastChangeAt = performance.now();

  for (;;) {
    await nextTick();
    const now = performance.now();
    const height = container.scrollHeight;
    const top = container.scrollTop;
    if (height !== lastHeight || Math.abs(top - lastTop) >= 0.01) {
      lastHeight = height;
      lastTop = top;
      lastChangeAt = now;
    }
    const stableMs = now - lastChangeAt;
    if (stableMs >= LAYOUT_STABLE_MS) {
      return { stableMs, timedOut: false };
    }
    if (now - startedAt > LAYOUT_SETTLE_TIMEOUT_MS) {
      return { stableMs, timedOut: true };
    }
  }
}

/** 等滚动真的开始（点击后动画可能一个帧周期之后才推进）。 */
async function waitForScrollStart(container: HTMLElement, fromScrollTop: number): Promise<boolean> {
  const startedAt = performance.now();
  for (;;) {
    await nextTick();
    if (Math.abs(container.scrollTop - fromScrollTop) >= 0.5) {
      return true;
    }
    if (performance.now() - startedAt > CLICK_SCROLL_DEADLINE_MS) {
      return false;
    }
  }
}

/** 把视口停在底部（与真实打开长会话一致：早期行远离视口，因而从未被渲染过）。 */
async function settleAtBottom(container: HTMLElement): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    container.scrollTop = container.scrollHeight;
    await nextTick();
    if (scrollState(container).bottomOffset <= 1) {
      break;
    }
    if (performance.now() - startedAt > 10_000) {
      break;
    }
  }
  await waitForScrollSettle(container);
}

/**
 * 行布局诊断：哪些行还停留在 200px 占位高度上、它们相对目标行的位置。
 *
 * 误差只来自「目标行之上的行用占位高度替代真实高度」，所以除了总数，还要单独数一遍
 * 目标行之上的占位行数——那是这条回归的杠杆。
 */
function collectRowDiagnostics(target: HTMLElement) {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]'));
  const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
  const placeholderIndexes = heights
    .map((height, index) => (height === PLACEHOLDER_HEIGHT_PX ? index : -1))
    .filter((index) => index >= 0);
  const targetIndex = rows.indexOf(target);
  const sampleIndexes = [0, 1, 2, 3, 4, targetIndex - 2, targetIndex - 1, targetIndex, targetIndex + 1, rows.length - 2, rows.length - 1]
    .filter((index) => index >= 0 && index < rows.length);

  return {
    totalRowCount: rows.length,
    placeholderRowCount: placeholderIndexes.length,
    firstPlaceholderRowIndex: placeholderIndexes[0] ?? null,
    lastPlaceholderRowIndex: placeholderIndexes[placeholderIndexes.length - 1] ?? null,
    targetRowIndex: targetIndex,
    placeholderRowsAboveTarget: placeholderIndexes.filter((index) => index < targetIndex).length,
    codeBlocks: collectCodeBlockAccounting(rows, targetIndex),
    samples: [...new Set(sampleIndexes)].map((index) => ({
      index,
      id: rows[index]?.id ?? null,
      height: heights[index] ?? null,
      checkVisibility: rows[index] ? checkVisibility(rows[index]!) : null,
      codeBlocks: rows[index] ? describeCodeBlocks(rows[index]!) : [],
    })),
  };
}

function checkVisibility(element: Element): boolean | null {
  if (typeof element.checkVisibility !== 'function') {
    return null;
  }
  return element.checkVisibility({ contentVisibilityAuto: true });
}

/** 与 MessageNav.scrollToMessage 等价的 DOM 计算路径（导航标记不可用时的退化路径）。 */
function domFallbackScroll(container: HTMLElement, target: HTMLElement): void {
  const offsetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({
    top: container.scrollTop + offsetTop - EXPECTED_RESIDUAL_PX,
    behavior: 'smooth',
  });
}

/** 走真实 UI 路径跳到某轮的用户消息，并量出落点残差。 */
async function measureTarget(
  container: HTMLElement,
  targetId: string,
  targetTurn: number,
  navButtons: HTMLButtonElement[],
): Promise<TargetMeasurement> {
  const startedAt = performance.now();
  const targetSelector = `#msg-${userMessageEventIndex(targetTurn)}`;

  await settleAtBottom(container);
  // 挂载后的异步渲染（markdown / 高亮）会让行高继续变，跳转前必须等布局真的静下来。
  const layoutSettle = await waitForLayoutSettled(container);
  const target = await waitForElement<HTMLElement>(targetSelector, MOUNT_TIMEOUT_MS);
  const rowDiagnostics = collectRowDiagnostics(target);
  const rowHeightsBefore = snapshotRows();
  const containerBoxBefore = describeContainerBox(container);
  const docTopViaOffsetChainBeforePx = measureDocTopViaOffsetChain(target, container);
  const targetHeightBeforeClickPx = target.getBoundingClientRect().height;
  const targetCheckVisibilityBeforeClick = checkVisibility(target);
  const targetWasSkippedBeforeClick = Math.round(targetHeightBeforeClickPx) === PLACEHOLDER_HEIGHT_PX;
  const scrollTopBeforeClick = container.scrollTop;
  const beforeScroll = scrollState(container);
  const estimatedOffsetTopPx = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  // scrollToMessage 实际请求的滚动位置（它写在容器上的那份算式）。
  const requestedScrollTopPx = scrollTopBeforeClick + estimatedOffsetTopPx - EXPECTED_RESIDUAL_PX;
  const targetDocTopBeforePx = estimatedOffsetTopPx + scrollTopBeforeClick;
  const computedStyle = window.getComputedStyle(target);
  const rowCountWithZeroHeight = Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]'))
    .filter((row) => Math.round(row.getBoundingClientRect().height) === 0).length;

  const button = navButtons[targetTurn];
  let navPath: NavPath = 'nav-marker-click';
  let navMarkerLabel = button?.getAttribute('aria-label') ?? null;

  // 时间线的原点就是这次点击；beginFlight 之后的尺寸变化都算在这一次跳转账上。
  beginFlight(rowDiagnostics.targetRowIndex);
  if (button) {
    button.click();
  } else {
    navPath = 'dom-fallback';
    navMarkerLabel = null;
    domFallbackScroll(container, target);
  }

  let scrollStarted = await waitForScrollStart(container, scrollTopBeforeClick);
  if (!scrollStarted && navPath === 'nav-marker-click') {
    // 标记点击没有产生滚动：退化为与 scrollToMessage 等价的 DOM 计算路径。
    // （无头窗口下 rAF 约 1fps，所以先给足等待时间，避免把「还没到第一帧」误判成路径失效。）
    navPath = 'dom-fallback';
    domFallbackScroll(container, target);
    scrollStarted = await waitForScrollStart(container, scrollTopBeforeClick);
  }

  const settle = await waitForScrollSettle(container, { expectChange: true, collectTrajectory: true });
  // 落定时刻先记账：之后（含下面这 3 个 tick）发生的尺寸变化全部标成 afterAnimationSettled。
  markFlightSettled();
  await tick(3);

  const residualPx = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const finalScroll = scrollState(container);
  const scrollTopAfterSettle = finalScroll.scrollTop;
  const targetDocTopAfterPx = residualPx + scrollTopAfterSettle;
  const rowsAfterSettle = snapshotRows();
  const rowHeightChanges = diffRows(rowHeightsBefore, rowsAfterSettle, rowDiagnostics.targetRowIndex);
  const containerBoxAfter = describeContainerBox(container);
  const docTopViaOffsetChainAfterPx = measureDocTopViaOffsetChain(target, container);
  const flightTimeline = snapshotFlightTimeline();
  const targetDocTopDriftPx = targetDocTopAfterPx - targetDocTopBeforePx;
  const postSettleRowStart = Math.max(0, rowDiagnostics.targetRowIndex - 6);
  const postSettleRows = rowsAfterSettle.slice(postSettleRowStart, rowDiagnostics.targetRowIndex + 7);
  return {
    targetId,
    targetTurn,
    targetSelector,
    targetWasSkippedBeforeClick,
    navPath,
    navMarkerIndex: targetTurn,
    navMarkerLabel,
    targetHeightBeforeClickPx,
    targetHeightAfterSettlePx: target.getBoundingClientRect().height,
    targetCheckVisibilityBeforeClick,
    rowDiagnostics,
    layoutStableMs: layoutSettle.stableMs,
    layoutSettleTimedOut: layoutSettle.timedOut,
    // 残差分解：residual = 22 + 布局漂移 − 滚动落点误差（三项都在下面，便于直接归因）。
    estimatedOffsetTopPx,
    requestedScrollTopPx,
    scrollTopErrorPx: scrollTopAfterSettle - requestedScrollTopPx,
    targetDocTopBeforePx,
    targetDocTopAfterPx,
    targetDocTopDriftPx,
    // 口径自查：容器盒模型是否前后一致、两条独立路径的漂移是否一致。
    containerBoxBefore,
    containerBoxAfter,
    docTopViaOffsetChainBeforePx,
    docTopViaOffsetChainAfterPx,
    docTopDriftViaOffsetChainPx:
      docTopViaOffsetChainBeforePx == null || docTopViaOffsetChainAfterPx == null
        ? null
        : docTopViaOffsetChainAfterPx - docTopViaOffsetChainBeforePx,
    driftVsSumAboveTargetPx: targetDocTopDriftPx - rowHeightChanges.sumAboveTargetPx,
    driftVsTimelineSumAbovePx: targetDocTopDriftPx - flightTimeline.sumAboveTargetRowPx,
    targetNodeStable: document.getElementById(targetSelector.slice(1)) === target,
    postSettleRows,
    flightTimeline,
    fontsStatusBeforeClick: fontTimeline.statusBeforeClick,
    fontsStatusAfterSettle: fontTimeline.statusAfterSettle,
    scrollHeightBeforeClickPx: beforeScroll.scrollHeight,
    scrollHeightAfterSettlePx: finalScroll.scrollHeight,
    scrollHeightDeltaPx: finalScroll.scrollHeight - beforeScroll.scrollHeight,
    computedContentVisibility: computedStyle.contentVisibility ?? null,
    rowHeightChanges,
    computedContainIntrinsicSize: computedStyle.containIntrinsicSize ?? null,
    rowCountWithZeroHeight,
    scrollStarted,
    scrollTopBeforeClick,
    scrollTopAfterSettle,
    scrollHeightPx: finalScroll.scrollHeight,
    clientHeightPx: finalScroll.clientHeight,
    settleTicks: settle.ticks,
    settleStableMs: settle.stableMs,
    settleTrajectory: settle.trajectory,
    settleTimedOut: settle.timedOut,
    residualPx,
    expectedResidualPx: EXPECTED_RESIDUAL_PX,
    elapsedMs: performance.now() - startedAt,
  };
}

async function runProbe(): Promise<ProbeResult> {
  const startedAt = performance.now();

  primeStores();

  // 诊断采集器全部是只读的（ResizeObserver / MutationObserver / fonts / Profiler），
  // 唯一会改变页面行为的是 anchor=none：它把容器的滚动锚定关掉，用来单独量这条候选。
  startFontObservation();
  const anchorOverride = new URLSearchParams(window.location.search).get('anchor');

  const rootElement = document.getElementById('probe-root');
  if (!rootElement) {
    throw new Error('页面缺少 #probe-root 挂载点');
  }

  createRoot(rootElement).render(
    // Profiler 只包一层（渲染成 Fragment，不产生 DOM），用来把行高变化对上一次提交。
    <Profiler id="codemux-thread-probe" onRender={(_id, phase) => recordCommit(phase)}>
      <TooltipProvider>
        <CodeMuxAssistantRuntimeProvider
          sessionId={LONG_SESSION_ID}
          onSend={async () => {}}
          onCommand={async () => {}}
        >
          <CodeMuxThread sessionId={LONG_SESSION_ID} />
        </CodeMuxAssistantRuntimeProvider>
      </TooltipProvider>
    </Profiler>,
  );

  const container = await waitForElement<HTMLElement>('[data-testid="thread-viewport"]', MOUNT_TIMEOUT_MS);
  const shell = await waitForElement<HTMLElement>('[data-testid="thread-content-shell"]', MOUNT_TIMEOUT_MS);
  const totalRowCount = await waitForStableRowCount(container);
  if (totalRowCount < PROBE_TURN_COUNT) {
    throw new Error(`消息行数量异常：${totalRowCount}（夹具为 ${PROBE_TURN_COUNT} 轮）`);
  }

  // 帧率决定「平滑滚动是否真的逐帧推进」，也就是这次测量是否具备触发条件。
  const rafRateHz = await measureRafRate();

  const containerBoxAfterMount = describeContainerBox(container);
  startMutationObservation(container);
  startLayoutObservation();
  // 帧采样循环：与滚动采样同节奏，只读 scrollTop/scrollHeight/fonts.status。
  void sampleFramesUntilStopped(container);

  if (anchorOverride != null) {
    // 诊断模式：关掉滚动锚定。浏览器在视口上方内容变高/变矮时会调整 scrollTop 来避免
    // 视觉跳动，这条调整会被算进「滚动落点误差」，不单独关掉就分不开它和动画误差。
    container.style.overflowAnchor = anchorOverride;
    document.documentElement.style.overflowAnchor = anchorOverride;
  }

  // 起点必须是底部：早期行远离视口，因而从未被渲染过。
  await settleAtBottom(container);
  const initialBottomOffsetPx = scrollState(container).bottomOffset;

  // 工单 03：尾部挂载窗口下主目标（turn 12）初始在窗口外。逐次点击「更早历史」
  // 延续标记，直到窗口覆盖全部已加载历史（标记消失）——按钮下标与轮次的对应
  // 关系因此保持，后续测量与窗口化之前逐字节一致。这一步同时验证
  // 「延续标记 → 窗口增长 → pre-paint 锚定」的整条链。
  let earlierHistoryClicks = 0;
  while (earlierHistoryClicks < 12) {
    const earlier = document.querySelector<HTMLButtonElement>('[data-testid="thread-earlier-history"]');
    if (!earlier) {
      break;
    }
    earlier.click();
    earlierHistoryClicks += 1;
    await settleAtBottom(container);
  }
  const navButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="message-nav"] button'),
  );
  if (navButtons.length <= PRIMARY_TARGET_TURN) {
    throw new Error(`导航标记数量不足：${navButtons.length}`);
  }

  const primary = await measureTarget(container, 'early-non-first', PRIMARY_TARGET_TURN, navButtons);
  // 对照目标在主目标之后测量：行会被第二次跳转预热，这一点在字段里如实标注。
  const literalEarliest = await measureTarget(container, 'literal-earliest', LITERAL_EARLIEST_TURN, navButtons);

  return {
    probe: 'codemux-transcript-probe',
    mode,
    turnCount: PROBE_TURN_COUNT,
    eventCount: buildLongSessionEvents(PROBE_TURN_COUNT).length,
    totalRowCount,
    longThreadAttrPresent: shell.hasAttribute('data-long-thread'),
    neutralizedByCss: mode === 'without-skip',
    anchorOverride,
    containerBoxAfterMount,
    fonts: { ...fontTimeline, loadingDoneAtMs: [...fontTimeline.loadingDoneAtMs], faces: [...fontTimeline.faces] },
    commits: { count: commitTimeline.count, dropped: commitTimeline.dropped, entries: [...commitTimeline.entries] },
    mutations: {
      count: mutationTimeline.count,
      dropped: mutationTimeline.dropped,
      entries: [...mutationTimeline.entries],
    },
    initialBottomOffsetPx,
    earlierHistoryClicks,
    primary,
    literalEarliest,
    rafRateHz,
    windowMode: new URLSearchParams(window.location.search).get('window') ?? 'headless',
    pageErrors: [...pageErrors],
    durationMs: performance.now() - startedAt,
  };
}

window.__CODEMUX_TRANSCRIPT_PROBE__ = {
  mode,
  errors: pageErrors,
  // 长会话阈值只用于把「夹具确实算长会话」这件事钉在入口里（事件数 240 > 120）。
  promise: runProbe().then((result) => {
    if (result.eventCount <= LONG_SESSION_EVENT_THRESHOLD) {
      throw new Error('夹具事件数未超过长会话阈值');
    }
    return result;
  }),
};
