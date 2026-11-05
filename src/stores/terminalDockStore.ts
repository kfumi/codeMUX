import { create } from 'zustand';

import { readLayoutPreferences, updateLayoutPreferences } from '../lib/layoutPreferences';

/** 底部终端面板高度的下限：再矮就连一行输出都看不全了。 */
export const TERMINAL_DOCK_MIN_HEIGHT = 140;

/** 默认高度；用户拖过之后用持久化的值。 */
export const TERMINAL_DOCK_DEFAULT_HEIGHT = 260;

/** 最多占对话列的一半，保证聊天区始终可用。 */
export const TERMINAL_DOCK_MAX_RATIO = 0.5;

export interface TerminalDockSession {
  id: string;
  projectPath: string;
  /** 标签标题：项目目录名 + 序号（序号 > 1 时）。 */
  title: string;
  /** 项目内的稳定序号，用于标题与 key 复用。 */
  index: number;
}

interface TerminalDockWorkspace {
  sessionIds: string[];
  activeSessionId: string | null;
}

interface TerminalDockState {
  isOpen: boolean;
  heightPx: number;
  isResizing: boolean;
  workspaces: Record<string, TerminalDockWorkspace>;
  sessions: Record<string, TerminalDockSession>;
  toggle: (projectPath: string | null) => void;
  open: (projectPath: string) => void;
  close: () => void;
  setHeight: (height: number, maxHeight?: number) => void;
  setResizing: (isResizing: boolean) => void;
  newTerminal: (projectPath: string) => string | null;
  closeTerminal: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  /** 项目被移除时清掉它的终端记录（PTY 由调用方 release）。 */
  releaseProject: (projectPath: string) => void;
  reset: () => void;
}

export function clampTerminalDockHeight(height: number, maxHeight?: number): number {
  const upperBound = Math.max(
    TERMINAL_DOCK_MIN_HEIGHT,
    maxHeight && Number.isFinite(maxHeight) && maxHeight > 0
      ? maxHeight
      : Number.POSITIVE_INFINITY,
  );
  return Math.round(Math.min(Math.max(height, TERMINAL_DOCK_MIN_HEIGHT), upperBound));
}

/** 取路径最后一段：`D:/project/app` → `app`，`/home/me/app` → `app`。 */
function projectLeaf(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || projectPath;
}

function terminalTitle(projectPath: string, index: number): string {
  const leaf = projectLeaf(projectPath);
  return index > 1 ? `${leaf} ${index}` : leaf;
}

/**
 * 会话 id 用单调序号，**不复用**：关掉再打开必须是新的实例（旧 PTY 可能还在收尾），
 * 而标签标题上的序号仍按「最小未使用」复用（关掉 2 再新建还叫 `app 2`）。
 */
let sessionSequence = 0;

function nextSessionId(projectPath: string): string {
  sessionSequence += 1;
  return `dock:${projectPath}:${sessionSequence}`;
}

/** 最小未使用序号：关掉 2 再新建仍然是 2（与 ZCode 的标签编号语义一致）。 */
function nextSessionIndex(workspace: TerminalDockWorkspace | undefined, sessions: Record<string, TerminalDockSession>): number {
  const used = new Set<number>();
  for (const id of workspace?.sessionIds ?? []) {
    const index = sessions[id]?.index;
    if (typeof index === 'number') used.add(index);
  }

  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

function createWorkspaceSession(
  projectPath: string,
  workspace: TerminalDockWorkspace | undefined,
  sessions: Record<string, TerminalDockSession>,
): { session: TerminalDockSession; workspace: TerminalDockWorkspace } {
  const index = nextSessionIndex(workspace, sessions);
  const session: TerminalDockSession = {
    id: nextSessionId(projectPath),
    projectPath,
    title: terminalTitle(projectPath, index),
    index,
  };

  return {
    session,
    workspace: {
      sessionIds: [...(workspace?.sessionIds ?? []), session.id],
      activeSessionId: session.id,
    },
  };
}

const initialPreferences = readLayoutPreferences();

export const useTerminalDockStore = create<TerminalDockState>((set, get) => ({
  isOpen: initialPreferences.terminalDockOpen ?? false,
  heightPx: clampTerminalDockHeight(initialPreferences.terminalDockHeight ?? TERMINAL_DOCK_DEFAULT_HEIGHT),
  isResizing: false,
  workspaces: {},
  sessions: {},

  toggle: (projectPath) => {
    if (get().isOpen) {
      get().close();
      return;
    }
    if (projectPath) get().open(projectPath);
  },

  open: (projectPath) => {
    if (!projectPath) return;

    const state = get();
    const workspace = state.workspaces[projectPath];
    if (workspace && workspace.sessionIds.length > 0) {
      set({ isOpen: true });
    } else {
      const { session, workspace: nextWorkspace } = createWorkspaceSession(projectPath, workspace, state.sessions);
      set({
        isOpen: true,
        sessions: { ...state.sessions, [session.id]: session },
        workspaces: { ...state.workspaces, [projectPath]: nextWorkspace },
      });
    }
    updateLayoutPreferences({ terminalDockOpen: true });
  },

  close: () => {
    set({ isOpen: false });
    updateLayoutPreferences({ terminalDockOpen: false });
  },

  setHeight: (height, maxHeight) => {
    set({ heightPx: clampTerminalDockHeight(height, maxHeight) });
  },

  setResizing: (isResizing) => set({ isResizing }),

  newTerminal: (projectPath) => {
    if (!projectPath) return null;

    const state = get();
    const { session, workspace } = createWorkspaceSession(
      projectPath,
      state.workspaces[projectPath],
      state.sessions,
    );
    set({
      isOpen: true,
      sessions: { ...state.sessions, [session.id]: session },
      workspaces: { ...state.workspaces, [projectPath]: workspace },
    });
    updateLayoutPreferences({ terminalDockOpen: true });
    return session.id;
  },

  closeTerminal: (sessionId) => {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) return;

    const workspace = state.workspaces[session.projectPath];
    if (!workspace) return;

    const closedIndex = workspace.sessionIds.indexOf(sessionId);
    const sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
    const activeSessionId = workspace.activeSessionId !== sessionId
      ? workspace.activeSessionId
      : sessionIds.length > 0
        ? sessionIds[Math.min(closedIndex, sessionIds.length - 1)]
        : null;

    const sessions = { ...state.sessions };
    delete sessions[sessionId];

    const workspaces = {
      ...state.workspaces,
      [session.projectPath]: { sessionIds, activeSessionId },
    };

    // 最后一个标签被关掉：面板收起（用户下一次打开会拿到一条新终端）。
    if (sessionIds.length === 0) {
      set({ sessions, workspaces, isOpen: false });
      updateLayoutPreferences({ terminalDockOpen: false });
      return;
    }

    set({ sessions, workspaces });
  },

  setActiveSession: (sessionId) => {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) return;
    const workspace = state.workspaces[session.projectPath];
    if (!workspace || workspace.activeSessionId === sessionId) return;

    set({
      workspaces: {
        ...state.workspaces,
        [session.projectPath]: { ...workspace, activeSessionId: sessionId },
      },
    });
  },

  releaseProject: (projectPath) => {
    const state = get();
    const workspace = state.workspaces[projectPath];
    if (!workspace) return;

    const sessions = { ...state.sessions };
    for (const id of workspace.sessionIds) delete sessions[id];
    const workspaces = { ...state.workspaces };
    delete workspaces[projectPath];

    set({ sessions, workspaces });
  },

  reset: () => set({
    isOpen: false,
    heightPx: TERMINAL_DOCK_DEFAULT_HEIGHT,
    isResizing: false,
    workspaces: {},
    sessions: {},
  }),
}));
