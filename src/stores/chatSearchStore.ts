/**
 * 聊天/命令搜索浮层的开合状态。
 *
 * 它是**布局/交互**状态而不是导航状态:浮层本身不改动当前会话或视图,
 * 放这里是为了让"打开搜索"这件事有单一落点 —— 侧栏的搜索按钮与
 * `openSearch` 快捷键(App 分发器)都改这个 store,不再由 `Sidebar` 的
 * 局部 useState 私有持有(局部状态没法被快捷键打开)。
 */
import { create } from 'zustand';

interface ChatSearchState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setOpen: (open: boolean) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setOpen: (open) => set({ isOpen: open }),
}));
