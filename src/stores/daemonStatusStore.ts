import { create } from 'zustand';

/**
 * 壳侧 daemon 生命周期标记:supervisor 观察到托管 daemon 意外退出或启动
 * 失败时置位,App 根组件的 overlay 据此展示「后台服务已断开」与重试入口。
 * 轻量布尔语义,不承载 daemon 的业务状态。
 */
export type DaemonProblemStatus = 'daemon-exited' | 'start-failed';

interface DaemonStatusState {
  problem: DaemonProblemStatus | null;
  error: string | null;
  /** 「重试」执行中,按钮禁用防重复点击。 */
  restarting: boolean;
  setProblem: (problem: DaemonProblemStatus, error?: string | null) => void;
  clearProblem: () => void;
  setRestarting: (restarting: boolean) => void;
}

export const useDaemonStatusStore = create<DaemonStatusState>((set) => ({
  problem: null,
  error: null,
  restarting: false,
  setProblem: (problem, error = null) => set({ problem, error: error ?? null }),
  clearProblem: () => set({ problem: null, error: null, restarting: false }),
  setRestarting: (restarting) => set({ restarting }),
}));
