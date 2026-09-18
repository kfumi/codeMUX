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
 */
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
/**
 * 行高快照：跳转前后各取一次，差值能直接指出「是哪些行在跳转途中改了高度」。
 * 这条回归的机制（占位高度 → 真实高度）与「异步渲染补齐」都会以行高变化的形式出现，
 * 只看残差无法区分两者。
 */
function snapshotRowHeights(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]'))
    .map((row) => Math.round(row.getBoundingClientRect().height));
}

function diffRowHeights(before: number[], after: number[], targetRowIndex: number) {
  const changes: Array<{ index: number; id: string | null; before: number; after: number }> = [];
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-message-row]'));
  const length = Math.min(before.length, after.length);
  let sumAboveTargetPx = 0;
  let sumBelowTargetPx = 0;

  for (let index = 0; index < length; index += 1) {
    const delta = (after[index] ?? 0) - (before[index] ?? 0);
    if (delta === 0) {
      continue;
    }
    if (index < targetRowIndex) {
      sumAboveTargetPx += delta;
    } else {
      sumBelowTargetPx += delta;
    }
    if (changes.length < 40) {
      changes.push({
        index,
        id: rows[index]?.id ?? null,
        before: before[index] ?? 0,
        after: after[index] ?? 0,
      });
    }
  }

  return {
    changedRowCount: changes.length,
    sumAboveTargetPx,
    sumBelowTargetPx,
    changes,
  };
}

type RowHeightChanges = {
  changedRowCount: number;
  /** 目标行之上所有行高变化之和（正 = 内容变高，把目标行往下推）。 */
  sumAboveTargetPx: number;
  /** 目标行及其下方所有行高变化之和。 */
  sumBelowTargetPx: number;
  changes: Array<{ index: number; id: string | null; before: number; after: number }>;
};

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

type ProbeMode = 'with-skip' | 'without-skip';
type NavPath = 'nav-marker-click' | 'dom-fallback';

type RowDiagnostics = {
  totalRowCount: number;
  /** 高度等于 200px 占位高度的行数：跳过规则确实参与布局的证据。 */
  placeholderRowCount: number;
  firstPlaceholderRowIndex: number | null;
  lastPlaceholderRowIndex: number | null;
  targetRowIndex: number;
  /** 目标行之上的占位行数——这条回归的全部杠杆都在这里。 */
  placeholderRowsAboveTarget: number;
  samples: Array<{ index: number; id: string | null; height: number | null; checkVisibility: boolean | null }>;
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
    samples: [...new Set(sampleIndexes)].map((index) => ({
      index,
      id: rows[index]?.id ?? null,
      height: heights[index] ?? null,
      checkVisibility: rows[index] ? checkVisibility(rows[index]!) : null,
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
  const rowHeightsBefore = snapshotRowHeights();
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
  await tick(3);

  const residualPx = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const finalScroll = scrollState(container);
  const scrollTopAfterSettle = finalScroll.scrollTop;
  const targetDocTopAfterPx = residualPx + scrollTopAfterSettle;
  const rowHeightChanges = diffRowHeights(rowHeightsBefore, snapshotRowHeights(), rowDiagnostics.targetRowIndex);
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
    targetDocTopDriftPx: targetDocTopAfterPx - targetDocTopBeforePx,
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

  const rootElement = document.getElementById('probe-root');
  if (!rootElement) {
    throw new Error('页面缺少 #probe-root 挂载点');
  }

  createRoot(rootElement).render(
    <TooltipProvider>
      <CodeMuxAssistantRuntimeProvider
        sessionId={LONG_SESSION_ID}
        onSend={async () => {}}
        onCommand={async () => {}}
      >
        <CodeMuxThread sessionId={LONG_SESSION_ID} />
      </CodeMuxAssistantRuntimeProvider>
    </TooltipProvider>,
  );

  const container = await waitForElement<HTMLElement>('[data-testid="thread-viewport"]', MOUNT_TIMEOUT_MS);
  const shell = await waitForElement<HTMLElement>('[data-testid="thread-content-shell"]', MOUNT_TIMEOUT_MS);
  const totalRowCount = await waitForStableRowCount(container);
  if (totalRowCount < PROBE_TURN_COUNT) {
    throw new Error(`消息行数量异常：${totalRowCount}（夹具为 ${PROBE_TURN_COUNT} 轮）`);
  }

  // 帧率决定「平滑滚动是否真的逐帧推进」，也就是这次测量是否具备触发条件。
  const rafRateHz = await measureRafRate();

  // 起点必须是底部：早期行远离视口，因而从未被渲染过。
  await settleAtBottom(container);
  const initialBottomOffsetPx = scrollState(container).bottomOffset;

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
    initialBottomOffsetPx,
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
