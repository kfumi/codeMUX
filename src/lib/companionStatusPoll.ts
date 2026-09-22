import { companionViaDaemon } from './facades/daemon-facade';
import type { CompanionRelayStatus, CompanionStatus, PairedDevice } from '../types/companion';

/**
 * 移动伴侣状态的**模块级单例**轮询器。
 *
 * 桌面端有两个消费方(SessionList 15s / CompanionSidebarButton 12s),以前各自
 * 起一个定时器、各自请求、各自 setState,每个 tick 还会把 loading 从 false 翻到
 * true 再翻回来,于是每 12s/15s 各带来两次重渲染。现在只有一个定时器、一个请求、
 * 一份共享状态:
 *
 * - 节拍取所有订阅方 interval 的**最小值**,没有订阅方时停表。
 * - 后台轮询走 `silent` 路径,不翻转 loading。
 * - 内容不变(status 深度比较,含 relay / pairedDevices)时保留旧引用、不发通知,
 *   订阅组件因此零重渲染。
 * - `document.hidden` 时跳过该次轮询,恢复可见时补拉一次(该监听只在**存在启用轮询的
 *   订阅方**时注册,所有订阅方都 `polling: false` 时既没有定时器也没有补拉)。
 */
export interface CompanionStatusPollState {
  status: CompanionStatus | null;
  loading: boolean;
  error: string | null;
}

export interface LoadCompanionStatusOptions {
  /** 静默轮询:不翻转 loading,成功/失败只在 error 真正变化时才通知。 */
  silent?: boolean;
}

export interface CompanionStatusSubscribeOptions {
  pollIntervalMs: number;
  polling: boolean;
}

export const DEFAULT_COMPANION_POLL_INTERVAL_MS = 12_000;

const INITIAL_STATE: CompanionStatusPollState = { status: null, loading: true, error: null };

let state: CompanionStatusPollState = INITIAL_STATE;

interface Subscriber {
  listener: () => void;
  intervalMs: number;
  polling: boolean;
}

const subscribers = new Set<Subscriber>();

let timer: ReturnType<typeof setInterval> | null = null;
let timerIntervalMs: number | null = null;
let listeningForVisibility = false;

interface InFlightLoad {
  promise: Promise<void>;
  /** 这次请求是否需要翻转 loading(非静默请求 / 被非静默订阅方加入的静默请求)。 */
  visible: boolean;
}

let inFlight: InFlightLoad | null = null;
/** 正在进行的「可见」请求数,归零时才把 loading 放回 false。 */
let visibleLoads = 0;

/**
 * 世代号。`resetCompanionStatusPollForTests` 会 +1,使**上一轮遗留的在飞请求**落地时直接
 * 丢弃结果——否则它的 `finally` 会写进下一个用例的模块状态并 emit 给下一个用例的订阅方,
 * 造成偶发红。
 */
let epoch = 0;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(): void {
  // 复制一份再遍历:监听器在回调里退订/新订都不会打乱本次通知。
  for (const subscriber of [...subscribers]) subscriber.listener();
}

function setState(patch: Partial<CompanionStatusPollState>): void {
  const next = { ...state, ...patch };
  if (next.status === state.status && next.loading === state.loading && next.error === state.error) {
    return;
  }
  state = next;
  emit();
}

function samePairedDevices(a: PairedDevice[], b: PairedDevice[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((device, index) => {
    const other = b[index];
    return (
      device.id === other.id &&
      device.name === other.name &&
      device.paired_at === other.paired_at &&
      (device.last_seen_at ?? null) === (other.last_seen_at ?? null)
    );
  });
}

function sameRelay(a: CompanionRelayStatus, b: CompanionRelayStatus): boolean {
  if (a === b) return true;
  return (
    a.enabled === b.enabled &&
    a.endpoint === b.endpoint &&
    a.useTls === b.useTls &&
    a.connectionState === b.connectionState &&
    (a.desktopPublicKeyB64 ?? null) === (b.desktopPublicKeyB64 ?? null)
  );
}

/**
 * 内容比较(daemon 每次返回的都是新对象,只有比较内容才能避免无意义重渲染)。
 * 导出供测试直接锁定「内容相同 = 不落状态」的语义。
 */
export function sameCompanionStatus(
  a: CompanionStatus | null,
  b: CompanionStatus | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.daemonReady === b.daemonReady &&
    (a.daemonError ?? null) === (b.daemonError ?? null) &&
    a.port === b.port &&
    (a.desktopId ?? null) === (b.desktopId ?? null) &&
    (a.lanIp ?? null) === (b.lanIp ?? null) &&
    (a.pairingCode ?? null) === (b.pairingCode ?? null) &&
    (a.pairingCodeExpiresAt ?? null) === (b.pairingCodeExpiresAt ?? null) &&
    samePairedDevices(a.pairedDevices, b.pairedDevices) &&
    sameRelay(a.relay, b.relay)
  );
}

/** 落状态:内容未变时**保留旧引用**,订阅组件因此不会重渲染。 */
function commitStatus(next: CompanionStatus): void {
  const unchanged = sameCompanionStatus(state.status, next);
  const status = unchanged ? state.status : next;
  if (status === state.status && state.error === null) return;
  state = { status, loading: state.loading, error: null };
  emit();
}

function beginVisibleLoad(): void {
  visibleLoads += 1;
  setState({ loading: true, error: null });
}

function endVisibleLoad(): void {
  visibleLoads = Math.max(0, visibleLoads - 1);
  if (visibleLoads === 0) setState({ loading: false });
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function handleVisibilityChange(): void {
  if (isDocumentHidden()) return;
  void loadCompanionStatus({ silent: true });
}

function tick(): void {
  if (isDocumentHidden()) return;
  void loadCompanionStatus({ silent: true });
}

function minPollingIntervalMs(): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (const subscriber of subscribers) {
    if (!subscriber.polling) continue;
    min = Math.min(min, subscriber.intervalMs);
  }
  return Number.isFinite(min) ? min : null;
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  timerIntervalMs = null;
  if (listeningForVisibility && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    listeningForVisibility = false;
  }
}

function syncTimer(): void {
  const intervalMs = minPollingIntervalMs();
  if (intervalMs === null) {
    stopTimer();
    return;
  }
  if (timer !== null && timerIntervalMs === intervalMs) return;
  stopTimer();
  timerIntervalMs = intervalMs;
  timer = setInterval(tick, intervalMs);
  if (!listeningForVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    listeningForVisibility = true;
  }
}

/**
 * 拉一次状态。同一时刻只有一个请求在飞:
 * - 静默请求加入正在飞的请求,不会多打一次。
 * - 非静默请求加入正在飞的静默请求时,把这次请求升级为「可见」(loading 置位)。
 */
export function loadCompanionStatus(options: LoadCompanionStatusOptions = {}): Promise<void> {
  const silent = options.silent === true;
  if (inFlight) {
    if (!silent && !inFlight.visible) {
      inFlight.visible = true;
      beginVisibleLoad();
    }
    return inFlight.promise;
  }

  const epochAtStart = epoch;
  const entry: InFlightLoad = { promise: Promise.resolve(), visible: !silent };
  entry.promise = (async () => {
    if (entry.visible) beginVisibleLoad();
    try {
      const next = await companionViaDaemon.getStatus();
      // 已经被 reset:这次结果属于上一轮,任何一个字节都不要落到当前状态里。
      if (epoch !== epochAtStart) return;
      commitStatus(next);
    } catch (error) {
      if (epoch !== epochAtStart) return;
      // 轮询失败也要把错误暴露出去(与旧行为一致),但不会翻转 loading。
      setState({ error: messageOf(error) });
    } finally {
      if (epoch === epochAtStart && entry.visible) {
        entry.visible = false;
        endVisibleLoad();
      }
      if (inFlight === entry) inFlight = null;
    }
  })();
  inFlight = entry;
  return entry.promise;
}

/** 动作方法(setEnabled 等)拿到的新状态走这里落库。 */
export function applyCompanionStatus(next: CompanionStatus): void {
  commitStatus(next);
}

export function setCompanionStatusError(error: string | null): void {
  setState({ error });
}

export function getCompanionStatusSnapshot(): CompanionStatusPollState {
  return state;
}

/** useSyncExternalStore 的订阅入口:注册订阅方,并按当前状态决定首帧是否可见加载。 */
export function subscribeCompanionStatus(
  listener: () => void,
  options: CompanionStatusSubscribeOptions,
): () => void {
  const subscriber: Subscriber = {
    listener,
    intervalMs: options.pollIntervalMs,
    polling: options.polling,
  };
  subscribers.add(subscriber);
  syncTimer();
  // 首次加载(还没有任何数据)翻 loading,已有数据时静默刷新,避免二次挂载闪 loading。
  void loadCompanionStatus({ silent: state.status !== null });
  return () => {
    subscribers.delete(subscriber);
    syncTimer();
  };
}

/** 测试专用:清空订阅方 / 定时器 / 在飞请求与状态,避免用例间串味。 */
export function resetCompanionStatusPollForTests(): void {
  subscribers.clear();
  stopTimer();
  inFlight = null;
  visibleLoads = 0;
  state = INITIAL_STATE;
  epoch += 1;
}
