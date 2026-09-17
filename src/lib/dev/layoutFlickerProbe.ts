/**
 * 布局闪动诊断探针（DEV 用）。
 *
 * 用途：定位"展开/收起折叠内容时，内容宽度反复变化 + 滚动条闪动"这类症状。
 * 这类问题在静态代码里找不到通路时，与其继续推断，不如直接记下**到底是哪个元素的
 * 哪个量在变，以及同一帧还发生了什么**。
 *
 * ## 与第一版的区别（第一版的教训）
 *
 * 第一版只在"点击折叠触发器之后"开始记录 —— **恰好错过了滚动条占位 10→0 的那一瞬**，
 * 只录到了 0 和之后的 10，等于把最关键的一次转换漏掉了。所以现在改成**常驻记录**：
 * 装上就开始按帧比较，只在数值变化时留一行，滚动缓冲有上限，随时可以导出。
 *
 * 除了尺寸，还记三样能解释"为什么会变"的东西：
 * - `bodyStyle` / `htmlStyle`：Radix 系组件（Dialog/DropdownMenu/Select 等）会经
 *   react-remove-scroll 往 body/html 写内联样式做滚动锁，那会改变整体布局宽度；
 * - `viewports`：匹配 `[data-testid="thread-viewport"]` 的元素个数 —— 若某些时刻 >1，
 *   说明有重挂载，`querySelector` 可能采到另一个元素；
 * - `vpId`：采样元素的稳定编号，用来判断"中途换了元素"而不是"同一个元素在变"。
 *
 * 只在显式开启时工作（浮层按钮写 `localStorage['codemux:layoutProbe']='1'`），
 * 关闭时不挂任何监听。
 */

const ENABLED_KEY = 'codemux:layoutProbe';
const MAX_ROWS = 600;
const VIEWPORT_SELECTOR = '[data-testid="thread-viewport"]';
const SHELL_SELECTOR = '[data-testid="thread-content-shell"]';

export type LayoutProbeRow = {
  t: number;
  source: string;
  /** clientWidth（内容盒，已排除滚动条占位） */
  cw: number;
  /** offsetWidth（边框盒，**包含**滚动条占位） */
  ow: number;
  sw: number;
  ch: number;
  sh: number;
  st: number;
  /** 父元素 clientWidth */
  pw: number;
  gutter: string;
  oy: string;
  /** 滚动锁痕迹：body / html 的内联样式（截断） */
  bodyStyle: string;
  htmlStyle: string;
  /** 当前匹配到的 viewport 元素个数 */
  viewports: number;
  /** 采样元素的稳定编号；变化即表示中途换了元素 */
  vpId: number;
};

export type LayoutProbeResult = {
  rows: LayoutProbeRow[];
  /** 视口 clientWidth 出现过几种取值 —— >1 说明内容宽度确实变过。 */
  viewportWidths: number[];
  /** 视口 `ow-cw`（滚动条占位）出现过几种取值 —— >1 说明滚动条在占位/不占位之间切。 */
  scrollbarSpaces: number[];
  /** 中途是否换过元素 */
  elementSwaps: number;
  /** 观察期间出现过的 body/html 内联样式（去重） */
  bodyStyles: string[];
  htmlStyles: string[];
};

const elementIds = new WeakMap<Element, number>();
let nextElementId = 1;

function elementId(element: Element): number {
  const existing = elementIds.get(element);
  if (existing != null) {
    return existing;
  }
  const assigned = nextElementId;
  nextElementId += 1;
  elementIds.set(element, assigned);
  return assigned;
}

function trimStyle(value: string | null): string {
  if (!value) {
    return '';
  }
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

function readRow(element: Element, source: string, t: number): LayoutProbeRow {
  const node = element as HTMLElement;
  const style = window.getComputedStyle(node);
  return {
    t,
    source,
    cw: node.clientWidth,
    ow: node.offsetWidth,
    sw: node.scrollWidth,
    ch: node.clientHeight,
    sh: node.scrollHeight,
    st: Math.round(node.scrollTop),
    pw: node.parentElement?.clientWidth ?? -1,
    gutter: style.scrollbarGutter,
    oy: style.overflowY,
    bodyStyle: trimStyle(document.body.getAttribute('style')),
    htmlStyle: trimStyle(document.documentElement.getAttribute('style')),
    viewports: document.querySelectorAll(VIEWPORT_SELECTOR).length,
    vpId: elementId(element),
  };
}

function isEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

let installed = false;

/**
 * 安装探针（装上即开始常驻记录）。返回 { uninstall, dump }。
 */
export function installLayoutFlickerProbe(): {
  uninstall: () => void;
  dump: () => LayoutProbeResult;
} {
  const noop = () => ({} as LayoutProbeResult);
  if (installed || typeof window === 'undefined') {
    return { uninstall: () => {}, dump: noop };
  }
  installed = true;

  const rows: LayoutProbeRow[] = [];
  const lastBySource = new Map<string, LayoutProbeRow>();
  let frame = 0;
  let stopped = false;

  const record = (element: Element, source: string) => {
    const row = readRow(element, source, Math.round(performance.now()));
    const previous = lastBySource.get(source);
    if (
      previous
      && previous.cw === row.cw
      && previous.ow === row.ow
      && previous.sw === row.sw
      && previous.ch === row.ch
      && previous.sh === row.sh
      && previous.st === row.st
      && previous.pw === row.pw
      && previous.viewports === row.viewports
      && previous.bodyStyle === row.bodyStyle
      && previous.htmlStyle === row.htmlStyle
      && previous.vpId === row.vpId
    ) {
      return;
    }
    lastBySource.set(source, row);
    rows.push(row);
    if (rows.length > MAX_ROWS) {
      rows.splice(0, rows.length - MAX_ROWS);
    }
  };

  const sample = () => {
    frame = 0;
    if (stopped) {
      return;
    }
    // 每帧都比较，但只在变化时记账 —— 常驻运行的开销是几次 clientWidth 读取。
    for (const element of document.querySelectorAll(VIEWPORT_SELECTOR)) {
      record(element, 'viewport');
    }
    for (const element of document.querySelectorAll(SHELL_SELECTOR)) {
      record(element, 'shell');
    }
    frame = window.requestAnimationFrame(sample);
  };

  const dump = (): LayoutProbeResult => {
    const viewportRows = rows.filter((row) => row.source === 'viewport');
    const result: LayoutProbeResult = {
      rows: [...rows],
      viewportWidths: [...new Set(viewportRows.map((row) => row.cw))],
      scrollbarSpaces: [...new Set(viewportRows.map((row) => row.ow - row.cw))],
      elementSwaps: [...new Set(viewportRows.map((row) => row.vpId))].length,
      bodyStyles: [...new Set(rows.map((row) => row.bodyStyle).filter(Boolean))],
      htmlStyles: [...new Set(rows.map((row) => row.htmlStyle).filter(Boolean))],
    };
    if (typeof console !== 'undefined') {
      console.groupCollapsed(
        `[layout-probe] ${rows.length} 条变化 · 视口宽度 ${JSON.stringify(result.viewportWidths)}`
        + ` · 滚动条占位 ${JSON.stringify(result.scrollbarSpaces)} · 元素编号 ${result.elementSwaps} 个`,
      );
      console.table(rows);
      if (result.bodyStyles.length > 0) {
        console.log('body 内联样式出现过：', result.bodyStyles);
      }
      if (result.htmlStyles.length > 0) {
        console.log('html 内联样式出现过：', result.htmlStyles);
      }
      console.groupEnd();
    }
    (globalThis as Record<string, unknown>).__codemuxLayoutProbe = result;
    return result;
  };

  frame = window.requestAnimationFrame(sample);

  return {
    uninstall: () => {
      stopped = true;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      installed = false;
    },
    dump,
  };
}

export function isLayoutProbeEnabled(): boolean {
  return isEnabled();
}

export function setLayoutProbeEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // localStorage 不可用时探针保持关闭。
  }
}

/** 供浮层/控制台读取最近一次导出结果。 */
export function readLastLayoutProbeResult(): LayoutProbeResult | null {
  const value = (globalThis as Record<string, unknown>).__codemuxLayoutProbe;
  return value ? (value as LayoutProbeResult) : null;
}
