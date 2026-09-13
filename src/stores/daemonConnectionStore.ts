/**
 * 宿主引导状态(工单 02):统一前端在拿到 daemon 连接前显示什么。
 *
 * - `connected`:连接就绪(桌面壳注入 / 浏览器已配对),可以挂载完整界面。
 * - `connecting`:正在解析配置或握手。
 * - `pairing`:没有可用连接,显示配对引导(同机简化配对 / 跨机配对码)。
 * - `error`:解析或连接失败,给「重试」入口。
 *
 * 状态只描述引导,不承载 daemon 业务数据(业务状态仍在各业务 store)。
 */
import { create } from 'zustand';

import { detectHostForm, readHostEnvironment, type HostForm } from '../lib/host/host-form';

export type DaemonConnectionStatus = 'idle' | 'connecting' | 'connected' | 'pairing' | 'error';

export type DaemonConnectionStrategy = 'shell-bridge' | 'paired-browser' | 'loopback-browser';

/** loopback = 同机浏览器简化配对;remote = 跨机配对码/扫码。 */
export type PairingMode = 'loopback' | 'remote';

export type PairingPhase = 'idle' | 'waiting' | 'claiming' | 'failed';

export interface PairingPrompt {
  mode: PairingMode;
  phase: PairingPhase;
  /** 同机配对时展示给用户的确认码。 */
  code: string | null;
  requestId: string | null;
  expiresAt: string | null;
  desktopId: string | null;
  message: string | null;
}

interface DaemonConnectionState {
  hostForm: HostForm;
  status: DaemonConnectionStatus;
  strategy: DaemonConnectionStrategy | null;
  error: string | null;
  pairing: PairingPrompt | null;
  begin: (hostForm: HostForm) => void;
  setConnecting: () => void;
  setConnected: (strategy: DaemonConnectionStrategy) => void;
  setPairingMode: (mode: PairingMode, message?: string | null) => void;
  setPairingWaiting: (input: {
    requestId: string;
    code: string;
    expiresAt: string;
    desktopId: string;
  }) => void;
  setPairingClaiming: (mode: PairingMode) => void;
  setPairingFailure: (message: string) => void;
  setError: (message: string) => void;
  reset: () => void;
}

export const useDaemonConnectionStore = create<DaemonConnectionState>((set) => ({
  // 首屏渲染前就能给出正确形态(壳桥存在与否是同步可判的)。
  hostForm: detectHostForm(readHostEnvironment()),
  status: 'idle',
  strategy: null,
  error: null,
  pairing: null,

  begin: (hostForm) => set({ hostForm }),
  setConnecting: () => set({ status: 'connecting', error: null, pairing: null }),
  setConnected: (strategy) => set({ status: 'connected', strategy, error: null, pairing: null }),
  setPairingMode: (mode, message = null) => set({
    status: 'pairing',
    strategy: null,
    error: message,
    pairing: {
      mode,
      phase: 'idle',
      code: null,
      requestId: null,
      expiresAt: null,
      desktopId: null,
      message,
    },
  }),
  setPairingWaiting: (input) => set((state) => ({
    status: 'pairing',
    error: null,
    pairing: {
      mode: state.pairing?.mode ?? 'loopback',
      phase: 'waiting',
      code: input.code,
      requestId: input.requestId,
      expiresAt: input.expiresAt,
      desktopId: input.desktopId,
      message: null,
    },
  })),
  setPairingClaiming: (mode) => set({
    status: 'pairing',
    error: null,
    pairing: {
      mode,
      phase: 'claiming',
      code: null,
      requestId: null,
      expiresAt: null,
      desktopId: null,
      message: null,
    },
  }),
  setPairingFailure: (message) => set((state) => ({
    status: 'pairing',
    error: null,
    pairing: {
      mode: state.pairing?.mode ?? 'loopback',
      phase: 'failed',
      code: state.pairing?.code ?? null,
      requestId: null,
      expiresAt: null,
      desktopId: state.pairing?.desktopId ?? null,
      message,
    },
  })),
  setError: (message) => set({ status: 'error', error: message, pairing: null }),
  reset: () => set({ status: 'idle', strategy: null, error: null, pairing: null }),
}));
