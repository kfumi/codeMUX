import { create } from 'zustand';

export const SLOW_IPC_CAP = 50;
export const RENDER_AGGREGATE_CAP = 50;
const IPC_RATE_WINDOW_MS = 1000;

export interface IpcSample {
  command: string;
  durationMs: number;
  timestamp: number;
  failed: boolean;
}

export interface RenderAggregate {
  id: string;
  commitCount: number;
  totalMs: number;
  baseTotalMs: number;
  lastSeen: number;
}

export interface PerfSnapshot {
  slowIpcSamples: IpcSample[];
  renderAggregates: RenderAggregate[];
  fps: number;
  memoryMb: number | null;
  slowThresholdMs: number;
  capturedAt: number;
}

interface PerfState {
  slowIpcSamples: IpcSample[];
  ipcTimestamps: number[];
  renderAggregates: Record<string, RenderAggregate>;
  renderOrder: string[];
  fps: number;
  memoryMb: number | null;
  overlayVisible: boolean;
  slowThresholdMs: number;

  recordIpc: (command: string, durationMs: number, failed: boolean) => void;
  pruneIpc: () => void;
  recordRender: (id: string, actualDurationMs: number, baseDurationMs: number, commitCount?: number) => void;
  setFps: (fps: number) => void;
  setMemoryMb: (mb: number | null) => void;
  setOverlayVisible: (visible: boolean) => void;
  setSlowThresholdMs: (ms: number) => void;
  getIpcRateNow: () => number;
  getTopSlowIpc: (n: number) => IpcSample[];
  getTopRenders: (n: number) => RenderAggregate[];
  snapshot: () => PerfSnapshot;
  reset: () => void;
}

function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  arr.push(item);
  if (arr.length > cap) {
    arr.splice(0, arr.length - cap);
  }
  return arr;
}

export const usePerfStore = create<PerfState>((set, get) => ({
  slowIpcSamples: [],
  ipcTimestamps: [],
  renderAggregates: {},
  renderOrder: [],
  fps: 0,
  memoryMb: null,
  overlayVisible: true,
  slowThresholdMs: 50,

  recordIpc: (command, durationMs, failed) => {
    const now = Date.now();
    const state = get();
    const nextSlow =
      durationMs >= state.slowThresholdMs
        ? pushCapped(
            [...state.slowIpcSamples],
            { command, durationMs, timestamp: now, failed },
            SLOW_IPC_CAP,
          )
        : state.slowIpcSamples;

    const nextTimestamps = [...state.ipcTimestamps, now];
    while (nextTimestamps.length > 0 && now - nextTimestamps[0] > IPC_RATE_WINDOW_MS) {
      nextTimestamps.shift();
    }

    set({ slowIpcSamples: nextSlow, ipcTimestamps: nextTimestamps });
  },

  pruneIpc: () => {
    const now = Date.now();
    const state = get();
    const next = [...state.ipcTimestamps];
    let changed = false;
    while (next.length > 0 && now - next[0] > IPC_RATE_WINDOW_MS) {
      next.shift();
      changed = true;
    }
    if (changed) {
      set({ ipcTimestamps: next });
    }
  },

  recordRender: (id, actualDurationMs, baseDurationMs, commitCount = 1) => {
    const now = Date.now();
    const state = get();
    const existing = state.renderAggregates[id];
    const aggregates = { ...state.renderAggregates };
    aggregates[id] = existing
      ? {
          id,
          commitCount: existing.commitCount + commitCount,
          totalMs: existing.totalMs + actualDurationMs,
          baseTotalMs: existing.baseTotalMs + baseDurationMs,
          lastSeen: now,
        }
      : { id, commitCount, totalMs: actualDurationMs, baseTotalMs: baseDurationMs, lastSeen: now };

    let order = state.renderOrder.filter((entry) => entry !== id);
    order.push(id);
    if (order.length > RENDER_AGGREGATE_CAP) {
      const evicted = order.splice(0, order.length - RENDER_AGGREGATE_CAP);
      for (const id of evicted) {
        delete aggregates[id];
      }
    }

    set({ renderAggregates: aggregates, renderOrder: order });
  },

  setFps: (fps) => set({ fps }),
  setMemoryMb: (memoryMb) => set({ memoryMb }),
  setOverlayVisible: (overlayVisible) => set({ overlayVisible }),
  setSlowThresholdMs: (slowThresholdMs) => set({ slowThresholdMs }),

  getIpcRateNow: () => {
    const now = Date.now();
    const timestamps = get().ipcTimestamps;
    let count = 0;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (now - timestamps[i] <= IPC_RATE_WINDOW_MS) {
        count++;
      } else {
        break;
      }
    }
    return count;
  },

  getTopSlowIpc: (n) =>
    [...get().slowIpcSamples].sort((a, b) => b.durationMs - a.durationMs).slice(0, n),

  getTopRenders: (n) =>
    Object.values(get().renderAggregates)
      .sort((a, b) => b.commitCount - a.commitCount)
      .slice(0, n),

  snapshot: () => {
    const s = get();
    return {
      slowIpcSamples: s.getTopSlowIpc(20),
      renderAggregates: s.getTopRenders(20),
      fps: s.fps,
      memoryMb: s.memoryMb,
      slowThresholdMs: s.slowThresholdMs,
      capturedAt: Date.now(),
    };
  },

  reset: () =>
    set({
      slowIpcSamples: [],
      ipcTimestamps: [],
      renderAggregates: {},
      renderOrder: [],
      fps: 0,
      memoryMb: null,
    }),
}));
