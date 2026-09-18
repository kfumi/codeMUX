/**
 * 快捷键命令的派发通道。
 *
 * 命令目录（`src/lib/shortcuts/keyboardShortcuts.ts`）只描述「有哪些命令、默认什么键位」，
 * 不持有执行体：执行体需要 App 级的导航回调与若干 store，只有 `App` 组装得出来。
 * 所以由 `App` 注册处理器，全局分发器与搜索对话框都通过这里派发，保证
 * 「同一个命令无论从键位还是从搜索结果触发，跑的都是同一段代码」。
 */
import { create } from 'zustand';

import type { ShortcutCommandId } from '../lib/shortcuts/keyboardShortcuts';

export type ShortcutCommandHandler = () => void;

export type ShortcutCommandHandlers = Partial<Record<ShortcutCommandId, ShortcutCommandHandler>>;

interface ShortcutCommandState {
  handlers: ShortcutCommandHandlers;
  setHandlers: (handlers: ShortcutCommandHandlers) => void;
  run: (id: ShortcutCommandId) => void;
}

export const useShortcutCommandStore = create<ShortcutCommandState>((set, get) => ({
  handlers: {},
  setHandlers: (handlers) => set({ handlers }),
  run: (id) => {
    get().handlers[id]?.();
  },
}));

/** 非 React 调用点用这个。 */
export function runShortcutCommand(id: ShortcutCommandId): void {
  useShortcutCommandStore.getState().run(id);
}

/** 命令是否可用（App 尚未注册时不该在搜索结果里露出）。 */
export function isShortcutCommandAvailable(id: ShortcutCommandId): boolean {
  return typeof useShortcutCommandStore.getState().handlers[id] === 'function';
}
