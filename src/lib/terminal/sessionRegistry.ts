/**
 * 终端会话 registry —— xterm 实例与 PTY 连接的唯一持有者。
 *
 * 这里的**所有权**在 React 之外：`TerminalView` 只把 `hostEl` 挂进容器、离开时摘回
 * stash，挂载/卸载不触发 start/attach/detach/dispose。只有显式关闭（`release`）才会
 * 销毁终端。这样切会话、切标签、收起面板、拖动改高都不会重建终端，滚动位置、选区、
 * 超长 scrollback 全部原样保留；daemon 侧的回放只用于渲染层重载这类进程级恢复。
 *
 * 尺寸管线也在这里：fit 用 rAF 合并；PTY 尺寸在最后一次变化后 `PTY_RESIZE_DEBOUNCE_MS`
 * 才发出，且单飞行 + latest-wins。拖动手柄或开合动画期间尺寸持续变化会让防抖自然重置，
 * 动画结束只补一次，因此不再需要探测宿主动画。
 *
 * 决策见 `docs/adr/0022-terminal-session-registry-ownership.md`。
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';

import { getIsDark, getPrefs, subscribe, subscribeIsDark } from '../appearance';
import type { TerminalEvent } from '../daemon-client/terminal';
import { daemonFacade } from '../facades/daemon-facade';
import {
  COMPOSED_INPUT_MATCH_WINDOW_MS,
  createComposedInputState,
  isWindowsComposedInputHost,
  noteComposedInput,
  noteTerminalData,
  resolveComposedInput,
} from './composedInputFallback';
import { openTerminalLink } from './openTerminalLink';
import { normalizePowerShellReadlineRedraw } from './terminalDataTransform';
import { createTerminalLinkProvider } from './terminalLinks';
import { TERMINAL_FONT_FAMILY, terminalTheme } from './terminalTheme';

/**
 * 终端标签在后台时的输出缓冲上限（字符数）。
 *
 * 超限后丢弃**最早**的输出并留下提示——这与 xterm 自己的 scrollback 在超限时丢弃最早行的
 * 语义一致，丢掉的也是已经滚出视野的内容。
 */
const INACTIVE_OUTPUT_MAX_CHARS = 128 * 1024;

/** 缓冲区发生过截断时插在最前面的提示，让用户知道上面的内容不完整。 */
const INACTIVE_OUTPUT_DROP_NOTICE = '\r\n[隐藏期间的早期输出已省略]\r\n';

/**
 * 把 PTY 尺寸同步给 daemon 前的稳定等待（毫秒）。
 *
 * 拖动改尺寸期间 `ResizeObserver` 每帧都会回调；如果每帧都 `resize` 一次 PTY，
 * 一次拖动就能打出十几次尺寸变更（Windows ConPTY 每次都会重绘，慢的机器上肉眼可见）。
 * 视觉上的 fit 仍然每帧做，只有发给 daemon 的尺寸等尺寸稳定后补一次。
 */
const PTY_RESIZE_DEBOUNCE_MS = 120;

/**
 * 面板开合过渡还在跑时的复查间隔（毫秒）。
 *
 * 过渡期间**不做 fit**：`ease-motion-in-out` 起步很慢，前 120ms 容器宽度还停在
 * 十几像素，fit 会把 xterm 重排到 1~2 列，随后防抖会把这个中间尺寸真的发给 PTY，
 * PowerShell/PSReadLine 就在两列宽下重画 prompt，留下永久残影（`PS` 单独一行、
 * 光标停在行首）。等过渡结束再 fit 一次，是这个问题的唯一干净解法。
 */
const PANEL_TRANSITION_RECHECK_MS = 60;

/**
 * RIS（ESC c）：把屏幕和 scrollback 一起复位。
 *
 * 回放前要清屏，但直接调 `terminal.reset()` 是同步的——之前还排在 write 队列里的
 * 旧输出会在 reset 之后才被解析，可能又叠到回放画面后面。把 RIS 作为一次普通 write
 * 排在回放前面，顺序就有了保证。
 */
const TERMINAL_RESET_SEQUENCE = '\x1bc';

/** 单个终端标签在跨会话、跨 surface 之间引用时使用的尺寸上限/下限兜底。 */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'error';

/** React 侧订阅的快照：只在状态真的变化时替换对象，供 `useSyncExternalStore` 使用。 */
export interface TerminalSessionSnapshot {
  status: TerminalSessionStatus;
  error: string | null;
  terminalId: string | null;
  shell: string | null;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalSession {
  key: string;
  projectPath: string;
  term: XTerm;
  fitAddon: FitAddon;
  /** xterm.open() 的宿主；在 surface 之间搬移的是它，不是 xterm 实例。 */
  hostEl: HTMLDivElement;
  terminalId: string | null;
  shell: string | null;
  status: TerminalSessionStatus;
  error: string | null;
  active: boolean;
  pendingOutput: string;
  pendingOutputIsReplay: boolean;
  disposers: Array<() => void>;
  snapshot: TerminalSessionSnapshot;
  observer: ResizeObserver | null;
  fitRaf: number | null;
  fitRetryTimer: number | null;
  focusRaf: number | null;
  resizeTimer: number | null;
  pendingSize: TerminalSize | null;
  lastSentSize: TerminalSize | null;
  resizeInFlight: boolean;
  /** IME 兜底的对账状态；非 Windows 宿主为 null。 */
  composedInput: ReturnType<typeof createComposedInputState> | null;
}

const EMPTY_SNAPSHOT: TerminalSessionSnapshot = {
  status: 'starting',
  error: null,
  terminalId: null,
  shell: null,
};

const sessions = new Map<string, TerminalSession>();
/**
 * 订阅者按 key 独立存放，**不挂在会话条目上**：`useSyncExternalStore` 会在首帧
 * 注册订阅，而条目要到 layout effect 里才创建；挂在条目上会丢掉这一次订阅。
 */
const sessionListeners = new Map<string, Set<() => void>>();
let appearanceSubscriptions: Array<() => void> | null = null;
let stashEl: HTMLDivElement | null = null;

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

/** 隐藏期间攒下的输出先放这里；`appendChild` 到 display:none 的容器即可保留 xterm 状态。 */
function getStash(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (!stashEl) {
    stashEl = document.createElement('div');
    stashEl.setAttribute('data-terminal-stash', '');
    stashEl.style.display = 'none';
    document.body.appendChild(stashEl);
  }
  return stashEl;
}

function updateSnapshot(entry: TerminalSession): void {
  if (
    entry.snapshot.status === entry.status
    && entry.snapshot.error === entry.error
    && entry.snapshot.terminalId === entry.terminalId
    && entry.snapshot.shell === entry.shell
  ) {
    return;
  }

  entry.snapshot = {
    status: entry.status,
    error: entry.error,
    terminalId: entry.terminalId,
    shell: entry.shell,
  };
  const listeners = sessionListeners.get(entry.key);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function reportError(entry: TerminalSession, error: unknown): void {
  entry.error = String(error);
  updateSnapshot(entry);
}

/**
 * 后台标签的终端**不解析**输出。
 *
 * xterm 的 `write` 是同步解析的：一个在后台跑着 dev server 的标签会持续占用主线程
 * 解析输出、推进 scrollback，即使根本没人看得见它。所以标签不在前台时只把输出攒起来，
 * 切回前台的那一帧再一次性写入。
 */
function writeOutput(entry: TerminalSession, text: string, isReplay = false): void {
  if (entry.active) {
    if (isReplay) {
      // 回放描述的是「这条终端现在的完整画面」，不是增量。重连/重挂载后直接写进去
      // 会把同一条 shell 的启动输出再叠一遍；先清屏（含 scrollback）再写。
      entry.pendingOutput = '';
      entry.pendingOutputIsReplay = false;
      entry.term.write(TERMINAL_RESET_SEQUENCE + text);
      return;
    }
    entry.term.write(text);
    return;
  }

  if (isReplay) {
    // 后台期间的重连回放同样覆盖而不是追加：它已经包含此时为止的全部输出。
    entry.pendingOutput = text;
    entry.pendingOutputIsReplay = true;
    return;
  }

  const next = entry.pendingOutput + text;
  if (next.length <= INACTIVE_OUTPUT_MAX_CHARS) {
    entry.pendingOutput = next;
    return;
  }

  // 超限时保留尾部，并且**从行界之后**开始：直接按字符切会把一条 ANSI 转义序列切成两半，
  // 终端就会把半截转义码当普通文本渲染出来。CR 也算行界——进度条那种用 `\r` 覆盖同一行
  // 的输出没有 `\n`，只找 `\n` 会退化成按字符切，等于没修。
  const overflowStart = next.length - INACTIVE_OUTPUT_MAX_CHARS;
  const breakOffset = next.slice(overflowStart).search(/[\r\n]/);
  entry.pendingOutput = breakOffset === -1
    // 整个尾部都没有行界（一条超长单行，例如无换行的 JSON/base64 转储）：此时任何字符级
    // 截断都可能切坏内容，宁可只留省略提示——这是唯一不会吐出半截转义码的选择。
    ? INACTIVE_OUTPUT_DROP_NOTICE
    : INACTIVE_OUTPUT_DROP_NOTICE + next.slice(overflowStart + breakOffset + 1);
}

function flushPendingOutput(entry: TerminalSession): void {
  const pending = entry.pendingOutput;
  if (!pending) return;

  const isReplay = entry.pendingOutputIsReplay;
  entry.pendingOutput = '';
  entry.pendingOutputIsReplay = false;
  entry.term.write(isReplay ? TERMINAL_RESET_SEQUENCE + pending : pending);
}

function handleEvent(entry: TerminalSession, event: TerminalEvent): void {
  if (event.type === 'output' && event.data != null) {
    // PSReadLine 的光标重绘会把行尾刷成黑底：在非纯黑背景下是一块灰。只改这一种。
    writeOutput(entry, normalizePowerShellReadlineRedraw(event.data, entry.shell), event.replay === true);
    return;
  }
  if (event.type === 'error') {
    entry.error = event.error ?? '终端错误';
    updateSnapshot(entry);
    return;
  }
  if (event.type === 'exit') {
    writeOutput(entry, `\r\n[进程已退出${event.code == null ? '' : `: ${event.code}`}]\r\n`);
    entry.status = 'exited';
    updateSnapshot(entry);
  }
}

function fitView(entry: TerminalSession): void {
  if (!entry.active) return;
  // 面板宽度/高度过渡期间不 fit：见 PANEL_TRANSITION_RECHECK_MS 的说明。
  if (hasRunningAncestorAnimation(entry.hostEl)) return;
  try {
    entry.fitAddon.fit();
  } catch {
    // 容器尚未布局完成（首帧、display:none）时 fit 会抛错；下一帧/下一次激活会补上。
  }
}

/**
 * 宿主自身或任意祖先是否正在跑 CSS 动画/过渡。
 *
 * 不绑定具体面板类型（旧实现只看 `closest('aside')`，底部 dock 的祖先不是 aside）：
 * 侧面板的宽度过渡、dock 的高度过渡都在这里命中。`getAnimations()` 默认只返回元素
 * 自身的动画，不会把子组件里的指示器动画算进来。
 */
function hasRunningAncestorAnimation(node: HTMLElement | null): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    if (typeof current.getAnimations === 'function') {
      try {
        if (current.getAnimations().some((animation) => animation.playState === 'running')) {
          return true;
        }
      } catch {
        // 某些环境下 getAnimations 会抛错（旧 WebView / 测试桩），按「没有动画」处理。
      }
    }
    current = current.parentElement;
  }
  return false;
}

function flushPtyResize(entry: TerminalSession): void {
  if (!entry.active || !entry.terminalId) return;

  const size: TerminalSize = { cols: entry.term.cols, rows: entry.term.rows };
  const last = entry.lastSentSize;
  if (!entry.pendingSize && last && last.cols === size.cols && last.rows === size.rows) {
    return;
  }

  // 同一时刻只允许一个在途请求；期间只保留最新尺寸，完成后补发。
  if (entry.resizeInFlight) {
    entry.pendingSize = size;
    return;
  }

  entry.pendingSize = null;
  entry.lastSentSize = size;
  entry.resizeInFlight = true;
  const terminalId = entry.terminalId;
  void daemonFacade.terminal.resize(terminalId, size.cols, size.rows)
    .catch((error) => {
      // 发送失败就把「已同步」清掉，下一次尺寸变化会重试。
      if (entry.lastSentSize === size) entry.lastSentSize = null;
      reportError(entry, error);
    })
    .finally(() => {
      entry.resizeInFlight = false;
      if (entry.pendingSize) flushPtyResize(entry);
    });
}

function schedulePtyResize(entry: TerminalSession): void {
  if (entry.resizeTimer !== null) window.clearTimeout(entry.resizeTimer);
  entry.resizeTimer = window.setTimeout(() => {
    entry.resizeTimer = null;
    flushPtyResize(entry);
  }, PTY_RESIZE_DEBOUNCE_MS);
}

/** 视觉 fit 每帧最多一次；PTY 尺寸另走防抖。 */
function requestFit(entry: TerminalSession): void {
  if (entry.fitRaf !== null) return;
  entry.fitRaf = scheduleFrame(() => {
    entry.fitRaf = null;
    if (!entry.active) return;
    // 面板过渡期间一次 fit 都不打算：等它结束（每 60ms 复查一次）再算最终尺寸。
    if (hasRunningAncestorAnimation(entry.hostEl)) {
      scheduleFitRetry(entry);
      return;
    }
    fitView(entry);
    schedulePtyResize(entry);
  });
}

function scheduleFitRetry(entry: TerminalSession): void {
  if (entry.fitRetryTimer !== null) return;
  entry.fitRetryTimer = window.setTimeout(() => {
    entry.fitRetryTimer = null;
    requestFit(entry);
  }, PANEL_TRANSITION_RECHECK_MS);
}

/**
 * `requestFocus` 要等一帧：`term.open()` 才创建隐藏 textarea，而 React 也刚刚切换完
 * 可见标签。只在仍然激活时抢焦点，避免把焦点从用户刚点的按钮上拽走。
 */
function requestFocus(entry: TerminalSession): void {
  if (entry.focusRaf !== null) cancelFrame(entry.focusRaf);
  entry.focusRaf = scheduleFrame(() => {
    entry.focusRaf = null;
    if (entry.active) entry.term.focus();
  });
}

function observeContainer(entry: TerminalSession, container: HTMLElement): void {
  entry.observer?.disconnect();
  entry.observer = null;
  if (typeof ResizeObserver === 'undefined') return;

  const observer = new ResizeObserver(() => requestFit(entry));
  observer.observe(container);
  entry.observer = observer;
}

function applyAppearanceToAll(): void {
  const prefs = getPrefs();
  const isDark = getIsDark();

  for (const entry of sessions.values()) {
    // 字号/主题是**纯视图选项**：只改 `options` 再重算尺寸，绝不重建 xterm ——
    // 重建等于换一条 PTY（旧缓冲丢失、daemon 侧多留一条会话）。
    if (entry.term.options.fontSize !== prefs.codeFontSize) {
      entry.term.options.fontSize = prefs.codeFontSize;
    }
    entry.term.options.theme = terminalTheme(isDark);
    requestFit(entry);
  }
}

function ensureAppearanceSubscriptions(): void {
  if (appearanceSubscriptions) return;
  appearanceSubscriptions = [subscribe(() => applyAppearanceToAll()), subscribeIsDark(() => applyAppearanceToAll())];
}

function writeToPty(entry: TerminalSession, data: string): void {
  const terminalId = entry.terminalId;
  if (!terminalId || !data) return;
  void daemonFacade.terminal.write(terminalId, data).catch((error) => reportError(entry, error));
}

/**
 * 终端内的交互：复制/粘贴键位、OSC 8 与纯文本链接、Windows IME 兜底。
 *
 * 这些能力挂在 xterm 实例上而不是组件上 —— 实例跨 surface 存活，能力也该跟着它走。
 */
function attachTerminalInteractions(entry: TerminalSession): void {
  const term = entry.term;

  if (typeof term.attachCustomKeyEventHandler === 'function') {
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (!(event.metaKey || event.ctrlKey)) return true;

      const key = event.key.toLowerCase();
      // 有选区时 Cmd/Ctrl+C 是复制，不能同时把 SIGINT 送进 shell。
      if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      // 自己读剪贴板并走 `term.paste`（会正确处理 bracketed paste）；返回 false 阻止
      // 浏览器原生粘贴再触发一次，否则会贴两遍。
      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard?.readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });
  }

  if (typeof term.registerLinkProvider === 'function') {
    term.registerLinkProvider(createTerminalLinkProvider(term, openTerminalLink));
  }

  installComposedInputFallback(entry);
}

/**
 * Windows 输入法兜底：组字结束的 `input` 与 xterm 的 `onData` 可能只出现一个。
 * 见 `composedInputFallback.ts` 的取舍说明。
 */
function installComposedInputFallback(entry: TerminalSession): void {
  if (!isWindowsComposedInputHost()) return;

  const textarea = entry.hostEl.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  const state = createComposedInputState();
  entry.composedInput = state;

  const onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    // 只处理输入法合成产生的 insertText（`composed` 为 true）。
    if (!inputEvent.composed) return;

    const text = inputEvent.data ?? textarea.value;
    if (!text) return;

    noteComposedInput(state, text, Date.now());
    window.setTimeout(() => {
      const resolution = resolveComposedInput(state);
      if (resolution.write) writeToPty(entry, resolution.write);
      if (resolution.clearTextarea) textarea.value = '';
    }, COMPOSED_INPUT_MATCH_WINDOW_MS);
  };

  textarea.addEventListener('input', onInput, true);
  entry.disposers.push(() => textarea.removeEventListener('input', onInput, true));
}

function startSession(entry: TerminalSession): void {
  entry.status = 'starting';
  updateSnapshot(entry);

  const cols = entry.term.cols || DEFAULT_COLS;
  const rows = entry.term.rows || DEFAULT_ROWS;
  entry.lastSentSize = { cols: entry.term.cols, rows: entry.term.rows };

  void daemonFacade.terminal.start(
    entry.projectPath,
    cols,
    rows,
    (event) => handleEvent(entry, event),
  ).then(({ terminalId, shell }) => {
    if (!sessions.has(entry.key)) {
      // 启动期间用户已经关掉了这个标签：把它创建的会话一并回收。
      void daemonFacade.terminal.close(terminalId).catch(() => {});
      return;
    }
    entry.terminalId = terminalId;
    entry.shell = shell ?? null;
    entry.status = 'running';
    updateSnapshot(entry);
    // 启动期间容器可能已经变过尺寸：只补视觉 fit，PTY 尺寸交给防抖（与旧实现一致）。
    fitView(entry);
  }).catch((error) => {
    entry.status = 'error';
    reportError(entry, error);
  });
}

function createSession(
  key: string,
  projectPath: string,
  container: HTMLElement,
  active: boolean,
): TerminalSession {
  const hostEl = document.createElement('div');
  hostEl.className = 'terminal-xterm-shell h-full min-h-0 w-full overflow-hidden';
  container.appendChild(hostEl);

  const prefs = getPrefs();
  const term = new XTerm({
    cursorBlink: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: prefs.codeFontSize,
    lineHeight: 1.35,
    scrollback: 5000,
    theme: terminalTheme(getIsDark()),
    // OSC 8 超链接：只放行 http(s)，交给我们自己的打开策略（内置浏览器 / 系统浏览器）。
    linkHandler: {
      allowNonHttpProtocols: false,
      activate: (event: MouseEvent, text: string) => {
        event.preventDefault();
        openTerminalLink(text);
      },
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(hostEl);
  // 先同步 fit 再启动 PTY：否则 shell 会以 80×24 启动，随后一次 resize 让启动输出整体重排。
  // 容器还没布局（dock 收起、面板隐藏）或面板正在开合时跳过，等过渡结束的 fit 补上。
  if (!hasRunningAncestorAnimation(hostEl)) {
    try {
      fitAddon.fit();
    } catch {
      // 下一次激活/ResizeObserver 会补上真实尺寸。
    }
  }

  const entry: TerminalSession = {
    key,
    projectPath,
    term,
    fitAddon,
    hostEl,
    terminalId: null,
    shell: null,
    status: 'starting',
    error: null,
    active,
    pendingOutput: '',
    pendingOutputIsReplay: false,
    disposers: [],
    snapshot: EMPTY_SNAPSHOT,
    observer: null,
    fitRaf: null,
    fitRetryTimer: null,
    focusRaf: null,
    resizeTimer: null,
    pendingSize: null,
    lastSentSize: null,
    resizeInFlight: false,
    composedInput: null,
  };

  const dataDisposable = term.onData((data) => {
    // 先记录：IME 兜底要靠这段数据判断「xterm 是否已经发过本次提交」。
    if (entry.composedInput) noteTerminalData(entry.composedInput, data, Date.now());
    writeToPty(entry, data);
  });
  entry.disposers.push(() => dataDisposable.dispose());

  attachTerminalInteractions(entry);

  sessions.set(key, entry);
  ensureAppearanceSubscriptions();
  observeContainer(entry, container);
  startSession(entry);
  return entry;
}

export interface AcquireTerminalOptions {
  projectPath: string;
  container: HTMLElement;
  /** 该标签是否正在前台展示；后台只缓冲输出，不解析。 */
  active: boolean;
}

/**
 * 取用（必要时创建）一条终端会话，并把宿主挂进 `container`。
 *
 * 条目已存在时**只搬 DOM**，不重新 start/attach —— 这是切 surface、切标签、StrictMode
 * 重放都不丢画面的原因。
 */
export function acquireSession(key: string, options: AcquireTerminalOptions): void {
  const existing = sessions.get(key);
  if (existing) {
    if (existing.projectPath !== options.projectPath) {
      // 同一个 key 被换给了另一个项目：旧会话不能复用（cwd 已经不对了）。
      releaseSession(key);
    } else {
      mountSession(key, options.container);
      setSessionActive(key, options.active);
      return;
    }
  }

  createSession(key, options.projectPath, options.container, options.active);
}

/** 只搬宿主 DOM；不改生命周期、不碰 PTY。 */
export function mountSession(key: string, container: HTMLElement): void {
  const entry = sessions.get(key);
  if (!entry) return;
  if (entry.hostEl.parentElement !== container) {
    container.appendChild(entry.hostEl);
  }
  observeContainer(entry, container);
  if (entry.active) requestFit(entry);
}

/** 把宿主摘到隐藏 stash：xterm 实例、滚动位置、选区全部保留。 */
export function unmountSession(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  entry.observer?.disconnect();
  entry.observer = null;
  const stash = getStash();
  if (stash && entry.hostEl.parentElement !== stash) {
    stash.appendChild(entry.hostEl);
  }
}

/**
 * 设置前台/后台。切到前台时把后台缓冲一次写入、重算尺寸、下一帧抢焦点；
 * 切到后台只改标志，不 detach、不 blur、不 refresh。
 */
export function setSessionActive(key: string, active: boolean): void {
  const entry = sessions.get(key);
  if (!entry) return;
  entry.active = active;
  if (!active) return;

  flushPendingOutput(entry);
  requestFit(entry);
  requestFocus(entry);
}

/** 唯一销毁路径：关闭 PTY、释放 xterm、摘掉宿主。幂等。 */
export function releaseSession(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);

  if (entry.fitRaf !== null) cancelFrame(entry.fitRaf);
  if (entry.fitRetryTimer !== null) window.clearTimeout(entry.fitRetryTimer);
  if (entry.focusRaf !== null) cancelFrame(entry.focusRaf);
  if (entry.resizeTimer !== null) window.clearTimeout(entry.resizeTimer);
  entry.observer?.disconnect();
  entry.observer = null;

  for (const dispose of entry.disposers) {
    try {
      dispose();
    } catch {
      // 订阅释放失败不应该阻止终端销毁。
    }
  }
  entry.disposers = [];

  const terminalId = entry.terminalId;
  entry.terminalId = null;

  const terminalElement = entry.hostEl;
  try {
    entry.term.dispose();
  } finally {
    terminalElement.remove();
  }

  if (terminalId) {
    void daemonFacade.terminal.close(terminalId).catch((error) => {
      console.error('Terminal session cleanup failed', error);
    });
  }
}

/** 释放满足条件的会话（项目被移除、宿主整体下线时使用）。 */
export function releaseSessionsWhere(predicate: (session: { key: string; projectPath: string }) => boolean): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (predicate({ key, projectPath: entry.projectPath })) {
      releaseSession(key);
    }
  }
}

export function getSessionSnapshot(key: string): TerminalSessionSnapshot {
  return sessions.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function hasSession(key: string): boolean {
  return sessions.has(key);
}

/** 右键菜单用：当前有没有选中文本。 */
export function hasSessionSelection(key: string): boolean {
  const term = sessions.get(key)?.term;
  return typeof term?.hasSelection === 'function' ? term.hasSelection() : false;
}

export function copySessionSelection(key: string): Promise<void> {
  const term = sessions.get(key)?.term;
  if (!term || typeof term.hasSelection !== 'function' || !term.hasSelection()) {
    return Promise.resolve();
  }
  return Promise.resolve(navigator.clipboard?.writeText(term.getSelection())).then(() => {});
}

/** 走 `term.paste`（bracketed paste 语义与键盘粘贴一致）。 */
export function pasteIntoSession(key: string): Promise<void> {
  const term = sessions.get(key)?.term;
  if (!term) return Promise.resolve();
  return navigator.clipboard.readText().then((text) => {
    if (text) term.paste(text);
  });
}

/** 供 React 订阅某条会话的状态（status/error）。返回退订函数。 */
export function subscribeSession(key: string, listener: () => void): () => void {
  let listeners = sessionListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    sessionListeners.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = sessionListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) sessionListeners.delete(key);
  };
}

/** 测试与热重启用：销毁全部会话并复位模块内的订阅。 */
export function releaseAllSessions(): void {
  for (const key of Array.from(sessions.keys())) {
    releaseSession(key);
  }
  if (appearanceSubscriptions) {
    for (const unsubscribe of appearanceSubscriptions) unsubscribe();
    appearanceSubscriptions = null;
  }
}

export const terminalRegistry = {
  acquire: acquireSession,
  mount: mountSession,
  unmount: unmountSession,
  setActive: setSessionActive,
  release: releaseSession,
  releaseWhere: releaseSessionsWhere,
  releaseAll: releaseAllSessions,
  getSnapshot: getSessionSnapshot,
  has: hasSession,
  hasSelection: hasSessionSelection,
  copySelection: copySessionSelection,
  paste: pasteIntoSession,
  subscribe: subscribeSession,
};
