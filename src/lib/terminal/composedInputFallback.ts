/**
 * Windows 中文输入法的 composed input 兜底。
 *
 * xterm 在 Windows 上处理输入法提交时有两种失败模式，且方向相反：
 * - **丢字**：组字结束的 `input` 事件有内容，但 xterm 的隐藏 textarea 没有把它转成
 *   `onData`，字就直接消失；
 * - **重复**：xterm 已经通过 `onData` 发了同一个字，兜底逻辑再发一次，于是出现两个。
 *
 * 这里不猜「xterm 到底发没发」，只用一个短窗口对账：composed input 先记下待定文本，
 * 若 150ms 内来的 `onData` 与之匹配，就判定已被 xterm 消费（不再补发）；否则把待定
 * 文本写进 PTY，并清空 textarea，避免下一次重复。
 *
 * 只在 Windows 上启用：Linux/Wayland 的 composed input 行为不同，套用这层反而会重复。
 */

/** 判定「这段 onData 就是刚才那次输入」的时间窗。 */
export const COMPOSED_INPUT_MATCH_WINDOW_MS = 150;

interface PendingComposedInput {
  text: string;
  at: number;
  handled: boolean;
}

export interface ComposedInputState {
  pending: PendingComposedInput | null;
  lastData: { text: string; at: number } | null;
}

export function createComposedInputState(): ComposedInputState {
  return { pending: null, lastData: null };
}

export function noteComposedInput(state: ComposedInputState, text: string, at: number): void {
  if (!text) return;
  state.pending = { text, at, handled: false };
}

/** xterm 的 `onData`：既记录最近一段数据，也尝试消除待定输入。 */
export function noteTerminalData(state: ComposedInputState, text: string, at: number): void {
  state.lastData = { text, at };

  const pending = state.pending;
  if (!pending || pending.handled) return;
  if (at - pending.at > COMPOSED_INPUT_MATCH_WINDOW_MS) return;
  if (matches(pending.text, text)) pending.handled = true;
}

export interface ComposedInputResolution {
  /** 需要补写到 PTY 的文本；`null` 表示 xterm 已经发过。 */
  write: string | null;
  /** 是否要清空隐藏 textarea（无论是否补写都要清，避免残留导致下一次重复）。 */
  clearTextarea: boolean;
}

export function resolveComposedInput(state: ComposedInputState): ComposedInputResolution {
  const pending = state.pending;
  state.pending = null;
  if (!pending) return { write: null, clearTextarea: false };
  return pending.handled
    ? { write: null, clearTextarea: true }
    : { write: pending.text, clearTextarea: true };
}

/** 只在 Windows 上启用；其它平台保持 xterm 原生行为。 */
export function isWindowsComposedInputHost(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Windows/i.test(navigator.userAgent);
}

function matches(pending: string, data: string): boolean {
  if (data === pending) return true;
  // xterm 可能把一次提交拆成多段（或反过来合并），用包含关系兜住这两种。
  return data.includes(pending) || pending.includes(data);
}
