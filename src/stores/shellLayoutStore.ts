/**
 * 壳/页面布局状态(工单 03)。
 *
 * 目前有两件事:窄屏抽屉式导航的开合,以及桌面形态下侧栏是否收起。它们都是
 * **布局**状态而不是导航状态 —— 放这里是为了让「导航发生后自动收起抽屉」这类
 * 跨组件规则有单一落点(导航仍归 [`navigationStore`](./navigationStore.ts) 管)。
 *
 * 桌面侧栏的收起状态此前是 `MainLayout` 的局部 state;把它提到这里,是为了让
 * 「折叠/展开侧边栏」成为一条可绑定的快捷键命令(见
 * [ADR 0013](../../docs/adr/0013-user-configurable-keyboard-shortcuts.md)),
 * 分发器只认 store,不该去猜某个组件的局部状态。
 */
import { create } from 'zustand';

interface ShellLayoutState {
  narrowSidebarOpen: boolean;
  setNarrowSidebarOpen: (open: boolean) => void;
  toggleNarrowSidebar: () => void;
  /** 桌面形态下侧栏是否收起(窄屏走抽屉,不看这个字段)。 */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** 按当前形态折叠/展开:窄屏开合抽屉,桌面收起/展开侧栏。 */
  toggleSidebar: (isNarrow: boolean) => void;
}

export const useShellLayoutStore = create<ShellLayoutState>((set) => ({
  narrowSidebarOpen: false,
  setNarrowSidebarOpen: (open) => set({ narrowSidebarOpen: open }),
  toggleNarrowSidebar: () => set((state) => ({ narrowSidebarOpen: !state.narrowSidebarOpen })),
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: (isNarrow) => set((state) => (isNarrow
    ? { narrowSidebarOpen: !state.narrowSidebarOpen }
    : { sidebarCollapsed: !state.sidebarCollapsed })),
}));
