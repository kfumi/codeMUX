/**
 * 壳/页面布局状态(工单 03)。
 *
 * 目前只有一件事:窄屏抽屉式导航的开合。它是**布局**状态而不是导航状态 ——
 * 放这里是为了让「导航发生后自动收起抽屉」这类跨组件规则有单一落点
 * (导航仍归 [`navigationStore`](./navigationStore.ts) 管)。
 */
import { create } from 'zustand';

interface ShellLayoutState {
  narrowSidebarOpen: boolean;
  setNarrowSidebarOpen: (open: boolean) => void;
  toggleNarrowSidebar: () => void;
}

export const useShellLayoutStore = create<ShellLayoutState>((set) => ({
  narrowSidebarOpen: false,
  setNarrowSidebarOpen: (open) => set({ narrowSidebarOpen: open }),
  toggleNarrowSidebar: () => set((state) => ({ narrowSidebarOpen: !state.narrowSidebarOpen })),
}));
