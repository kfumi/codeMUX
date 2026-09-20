//! 主窗口尺寸/位置持久化:旧 Tauri 壳由官方 window-state 插件承担,壳迁移到
//! Electron 后在主进程手写等价能力(不引入新依赖)。
//!
//! - 状态存 userData/window-state.json(与 Tauri 同一数据目录);
//! - resize/move 去抖 500ms 落盘,close 时同步补写一次;
//! - 只记录「正常态」bounds:最大化/最小化/全屏期间不覆盖尺寸,仅记
//!   maximized 标记,恢复时按标记重放最大化;
//! - 恢复时按目标显示器当前工作区钳制尺寸、校验位置 —— 分辨率/显示器
//!   变化后旧尺寸不会被撑出屏幕,位置失效则回落居中。

import { app, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

export interface WindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  maximized: boolean;
}

const STATE_FILE = 'window-state.json';
const SAVE_DEBOUNCE_MS = 500;

function resolveStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function rectsIntersect(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

/** 读取持久化状态;按目标显示器工作区钳制,损坏/缺失回落默认值。 */
export function loadWindowState(fallback: { width: number; height: number }): WindowState {
  const state: WindowState = {
    width: fallback.width,
    height: fallback.height,
    x: null,
    y: null,
    maximized: false,
  };

  try {
    const raw = JSON.parse(readFileSync(resolveStatePath(), 'utf8')) as Record<string, unknown>;
    const width = readNumber(raw.width);
    const height = readNumber(raw.height);
    if (width !== null && width > 0) state.width = width;
    if (height !== null && height > 0) state.height = height;
    state.x = readNumber(raw.x);
    state.y = readNumber(raw.y);
    state.maximized = raw.maximized === true;
  } catch {
    // 无状态文件或损坏:直接用默认尺寸,不值得告警(首启必走这里)。
    return state;
  }

  // screen 在 app ready 后才可用;createMainWindow 只在 ready 后调用。
  const display = state.x !== null && state.y !== null
    ? screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height })
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;

  state.width = Math.min(state.width, workArea.width);
  state.height = Math.min(state.height, workArea.height);

  const positioned = state.x !== null && state.y !== null
    && rectsIntersect({ x: state.x, y: state.y, width: state.width, height: state.height }, workArea);
  if (!positioned) {
    state.x = workArea.x + Math.floor((workArea.width - state.width) / 2);
    state.y = workArea.y + Math.floor((workArea.height - state.height) / 2);
  }
  return state;
}

/** 挂接 resize/move/close 落盘;返回解挂函数(当前窗口生命周期 = 应用,无需调用)。 */
export function attachWindowStatePersistence(window: BrowserWindow): void {
  // 以创建时的 bounds 兜底:首次运行就最大化再关闭,正常态尺寸也有据可存。
  let lastNormalBounds = { ...window.getBounds() };
  let timer: NodeJS.Timeout | null = null;

  const persist = (maximized: boolean) => {
    const state: WindowState = { ...lastNormalBounds, maximized };
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(resolveStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (error) {
      console.warn('[window-state] save failed:', error);
    }
  };

  const schedule = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    if (!window.isMaximized()) {
      lastNormalBounds = window.getBounds();
    }
    const maximized = window.isMaximized();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist(maximized);
    }, SAVE_DEBOUNCE_MS);
  };

  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('maximize', schedule);
  window.on('unmaximize', schedule);

  // close 时窗口 bounds 可能已不可信(隐藏到托盘路径),直接补写最后已知状态。
  window.on('close', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (window.isDestroyed() || window.isMinimized()) return;
    if (!window.isMaximized()) {
      lastNormalBounds = window.getBounds();
    }
    persist(window.isMaximized());
  });
}
