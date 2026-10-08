import { createLogger } from './logger';
import { ensureDaemonClient } from './facades/daemon-facade';

const logger = createLogger('daemon-session-bridge');

/**
 * An event as it reaches a session handler. The WebSocket path already holds a
 * parsed object, so handlers accept either shape instead of forcing a
 * `JSON.stringify` that the store immediately parses back. Legacy string
 * producers (direct sidecar streams, test doubles) keep working unchanged.
 */
export type SessionEventPayload = string | Record<string, unknown>;

type SessionEventHandler = (event: SessionEventPayload) => void;
type SessionStateHandler = (running: boolean) => void;
type SessionTimelineResetHandler = () => void;

/**
 * daemon 重建了会话时间线(回退 / 从原生重同步 / 导入刷新)时下发的帧类型。
 * 与 `crates/daemon/src/companion/events.rs` 的 `timeline_reset` 成对存在。
 */
export const TIMELINE_RESET_EVENT_TYPE = 'timeline_reset';

/** 丢帧告警的节流间隔:丢帧是「每帧都发生」的状态,不能每帧打一行。 */
const DROPPED_FRAME_LOG_INTERVAL_MS = 5000;

const handlers = new Map<string, SessionEventHandler>();
const stateHandlers = new Map<string, SessionStateHandler>();
const timelineResetHandlers = new Map<string, SessionTimelineResetHandler>();
const unsubscribeFns = new Map<string, () => void>();
const lastSequenceBySession = new Map<string, number>();
const droppedFrameLoggedAt = new Map<string, number>();

/** 最近一次**被接受**的帧到达时刻:用于区分「连接回放的正常去重」与「流真的卡住了」。 */
const lastAcceptedFrameAt = new Map<string, number>();

/**
 * 多久没有接受过任何帧,才把丢帧当成异常上报。
 *
 * WS 每次连接都会回放 timeline tail(见 daemon 的 `handle_socket`),这些帧本来就该被
 * 水位线吃掉 —— 不加这层静默期的话,每次重连都会刷一行 warn,把真正的
 * 「整条流被水位线挡死」信号淹没。
 */
const DROPPED_FRAME_QUIET_MS = 10_000;

export function registerDaemonSessionHandler(
  sessionId: string,
  handler: SessionEventHandler,
  onState?: SessionStateHandler,
  onTimelineReset?: SessionTimelineResetHandler,
): void {
  handlers.set(sessionId, handler);
  if (onState) {
    stateHandlers.set(sessionId, onState);
  }
  if (onTimelineReset) {
    timelineResetHandlers.set(sessionId, onTimelineReset);
  }
  void ensureDaemonSubscription(sessionId);
}

export function unregisterDaemonSessionHandler(sessionId: string): void {
  handlers.delete(sessionId);
  stateHandlers.delete(sessionId);
  timelineResetHandlers.delete(sessionId);
}

export function getLastEventSequence(sessionId: string): number {
  return lastSequenceBySession.get(sessionId) ?? -1;
}

export function setLastEventSequence(sessionId: string, sequence: number): void {
  lastSequenceBySession.set(sessionId, sequence);
  acceptedSequences(sessionId).add(sequence);
}

/**
 * 每会话「已接受帧」的序号集合。
 *
 * 水位线只能表达「已看到的最高序号」，表达不了**中间的洞**：实时帧在乱序窗口里
 * 丢失（实测 daemon 的 state 帧会先于收尾事件帧到达，随后丢掉 summary 帧）后，
 * 后续帧照常抬水位线，丢掉的那帧就落在水位线之下 —— cursor 补拉（`after 水位线`）
 * 永远拉不回它。补拉因此改为拉时间线尾部并按这个集合逐帧去重（见
 * `catchUpTimelineAfterSequence`），洞里的帧不在集合中，会被补喂。
 */
const acceptedSequencesBySession = new Map<string, Set<number>>();

function acceptedSequences(sessionId: string): Set<number> {
  let accepted = acceptedSequencesBySession.get(sessionId);
  if (!accepted) {
    accepted = new Set<number>();
    acceptedSequencesBySession.set(sessionId, accepted);
  }
  return accepted;
}

/**
 * 回退去重水位线。
 *
 * daemon 的 `sequence` 由 `MAX(sequence) + 1` 分配(见
 * `operations::append_timeline_events`),时间线被整体重建时
 * (`replace_session_timeline` 从 0 重新编号 / `clear_session_timeline`)序号空间会
 * **整体回退**。水位线只增不减的话,重建之后每一帧都会命中下方的
 * `sequence <= last` 被静默丢弃 —— 包括回合终止帧,于是 UI 永远停在「正在执行」,
 * 输入框一直禁用,连回退与「从 CLI 同步历史」都被挡在门外。
 */
export function resetLastEventSequence(sessionId: string, sequence = -1): void {
  lastSequenceBySession.set(sessionId, sequence);
  // 序号空间整体回退（时间线重建）后，旧空间里记录的「已接受」序号全部作废：
  // 留着它们会让补拉把重建后的帧误判为重复。
  acceptedSequencesBySession.delete(sessionId);
}

/**
 * 历史加载把整页 DB 事件喂进 store 后，把这些序号记为已接受。
 *
 * 只应在「加载结果替换了 store 时间线」的分支调用：替换后的 store 内容与 DB
 * 逐帧一致，补拉据此跳过它们。若加载结果被丢弃（保留本地实时时间线），不能
 * 标记 —— DB 里有而本地丢掉的帧（乱序窗口的洞）必须留给补拉补喂。
 */
export function markTimelineSequencesAccepted(sessionId: string, sequences: number[]): void {
  if (sequences.length === 0) return;
  const accepted = acceptedSequences(sessionId);
  for (const sequence of sequences) {
    accepted.add(sequence);
  }
}

/**
 * 历史加载完成后与水位线对账。
 *
 * 更高的序号照常抬高水位线;而**低于**水位线的加载结果只有一个解释:daemon 重建了
 * 时间线并重新编号。此时必须回退水位线,否则该会话此后所有实时帧都会被丢掉
 * (WS 重连后的 catch-up 重放同样会被吃掉,形成永久空洞)。
 */
export function reconcileHistorySequence(
  sessionId: string,
  highest: number,
): 'reset' | 'advanced' | 'unchanged' {
  if (highest < 0) {
    return 'unchanged';
  }
  const current = getLastEventSequence(sessionId);
  if (current >= 0 && highest < current) {
    resetLastEventSequence(sessionId, highest);
    logger.warn('Session timeline sequence regressed; rewinding frame watermark', {
      sessionId,
      previous: current,
      reloaded: highest,
    });
    return 'reset';
  }
  if (highest > current) {
    setLastEventSequence(sessionId, highest);
    return 'advanced';
  }
  return 'unchanged';
}

/** 丢帧必须能看见:原实现静默 `return`,线上只能靠对比日志反推。 */
function noteDroppedFrame(sessionId: string, sequence: number, watermark: number): void {
  const now = Date.now();
  // 刚接受过帧 → 大概率只是重连回放里那些「本该被丢掉」的旧帧。
  if (now - (lastAcceptedFrameAt.get(sessionId) ?? 0) < DROPPED_FRAME_QUIET_MS) {
    return;
  }
  const lastLoggedAt = droppedFrameLoggedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
  if (now - lastLoggedAt < DROPPED_FRAME_LOG_INTERVAL_MS) {
    return;
  }
  droppedFrameLoggedAt.set(sessionId, now);
  logger.warn('Dropped live session frame below the sequence watermark', {
    sessionId,
    sequence,
    watermark,
  });
}

export async function catchUpTimelineAfterSequence(sessionId: string): Promise<void> {
  const after = getLastEventSequence(sessionId);
  if (after < 0) return;
  try {
    const client = await ensureDaemonClient();
    const handler = handlers.get(sessionId);
    if (!handler) return;
    // 拉尾部而非 `after 水位线`：水位线之下的洞（乱序窗口里丢掉的帧，实测是
    // 产物汇总帧）cursor 补拉永远拉不回来，只能按「已接受序号集合」逐帧对账。
    // 集合去重保证已接受的帧（含洞后已到达的帧）不会被重复投喂。
    const page = await client.getTimeline(sessionId, { direction: 'tail', limit: 200 });
    const accepted = acceptedSequences(sessionId);
    for (const event of page.events ?? []) {
      if (event && typeof event === 'object') {
        const record = event as Record<string, unknown>;
        const sequence = typeof record.sequence === 'number' ? record.sequence : null;
        if (sequence !== null) {
          const alreadyAccepted = accepted.has(sequence);
          accepted.add(sequence);
          setLastEventSequence(sessionId, Math.max(getLastEventSequence(sessionId), sequence));
          if (alreadyAccepted) {
            continue;
          }
        }
        handler(record);
      }
    }
  } catch (error) {
    logger.warn('Failed to catch up timeline after reconnect', { sessionId }, error as Error);
  }
}

/**
 * 重连后的水位线对账兜底。
 *
 * `timeline_reset` 帧只覆盖「客户端在线时发生的重建」:启动期清理
 * (`cleanup_legacy_timeline_artifacts`)、导入刷新、以及 WS 断开窗口里的重建都收不到它,
 * 而这时水位线仍停在旧序号空间 —— 服务端回放与 catch-up 都会被它吃掉,形成永久空洞。
 * 所以每次重连额外读一次 tail 页的最高序号交给 `reconcileHistorySequence` 判断:
 * 判定为回退就按新序号重设水位线,并让上层重拉时间线。
 */
export async function reconcileSequenceAfterReconnect(sessionId: string): Promise<void> {
  try {
    const client = await ensureDaemonClient();
    const page = await client.getTimeline(sessionId, { direction: 'tail', limit: 8 });
    const seqEnd = (page as { seqEnd?: number }).seqEnd;
    if (typeof seqEnd !== 'number') return;
    if (reconcileHistorySequence(sessionId, seqEnd) === 'reset') {
      logger.warn('Timeline ceiling regressed after reconnect; reloading session history', {
        sessionId,
        seqEnd,
      });
      timelineResetHandlers.get(sessionId)?.();
    }
  } catch (error) {
    logger.warn('Failed to reconcile timeline ceiling after reconnect', { sessionId }, error as Error);
  }
}

/**
 * daemon 重建时间线后的水位线回退:按帧里带的新高水位回退,再让上层把内存里
 * 过期的时间线重拉一遍(否则客户端仍会按旧序号空间丢帧)。
 */
function handleTimelineReset(sessionId: string, record: Record<string, unknown>): void {
  const rawMax = typeof record.sequence_max === 'number'
    ? record.sequence_max
    : typeof record.sequenceMax === 'number'
      ? record.sequenceMax
      : -1;
  const previous = getLastEventSequence(sessionId);
  resetLastEventSequence(sessionId, rawMax);
  logger.warn('Daemon rebuilt the session timeline; frame watermark rewound', {
    sessionId,
    previous,
    sequenceMax: rawMax,
  });
  timelineResetHandlers.get(sessionId)?.();
}

async function ensureDaemonSubscription(sessionId: string): Promise<void> {
  if (unsubscribeFns.has(sessionId)) return;
  try {
    const client = await ensureDaemonClient();
    // 订阅(重新)建立:接下来一小段是服务端的 tail 回放,那段窗口内的去重是正常的。
    lastAcceptedFrameAt.set(sessionId, Date.now());
    const unsubscribe = client.subscribeSession(sessionId, {
      getInitialSequence: () => getLastEventSequence(sessionId),
      onEvent: (event) => {
        const handler = handlers.get(sessionId);
        if (!handler || !event || typeof event !== 'object') return;
        const record = event as Record<string, unknown>;
        if (record.type === TIMELINE_RESET_EVENT_TYPE) {
          handleTimelineReset(sessionId, record);
          return;
        }
        const sequence = typeof record.sequence === 'number' ? record.sequence : null;
        if (sequence !== null) {
          const last = getLastEventSequence(sessionId);
          if (sequence <= last) {
            // 水位线之下的回放帧不投喂(去重),但也**不标记已接受**:它可能正是
            // 乱序窗口里丢掉的洞(实测是产物汇总帧)——一旦标记,尾部对账会把它
            // 当成已接受永远跳过,卡片再次永久丢失。是洞就交给补拉补喂;
            // 已在 store 的帧会被补拉的接受集合跳过,不会重复。
            noteDroppedFrame(sessionId, sequence, last);
            return;
          }
          setLastEventSequence(sessionId, sequence);
        }
        lastAcceptedFrameAt.set(sessionId, Date.now());
        handler(record);
      },
      onState: (running) => {
        stateHandlers.get(sessionId)?.(running);
      },
      onReconnect: () => {
        void catchUpTimelineAfterSequence(sessionId);
        // 重连是唯一能确定「错过了什么」的时机:顺便按服务端序号上限对账水位线。
        void reconcileSequenceAfterReconnect(sessionId);
      },
    });
    unsubscribeFns.set(sessionId, unsubscribe);
    // 首次订阅同样要对账:订阅之前发生的时间线重建(启动期清理、其他客户端回退/重同步)
    // 没有 timeline_reset 通知,而本地水位线可能还停在重建前的序号空间。
    void reconcileSequenceAfterReconnect(sessionId);
  } catch (error) {
    logger.warn('Failed to subscribe daemon session WS', { sessionId }, error as Error);
  }
}

export function teardownDaemonSession(sessionId: string): void {
  handlers.delete(sessionId);
  stateHandlers.delete(sessionId);
  timelineResetHandlers.delete(sessionId);
  lastAcceptedFrameAt.delete(sessionId);
  droppedFrameLoggedAt.delete(sessionId);
  acceptedSequencesBySession.delete(sessionId);
  const unsubscribe = unsubscribeFns.get(sessionId);
  if (unsubscribe) {
    unsubscribe();
    unsubscribeFns.delete(sessionId);
  }
}

export function resetDaemonSessionBridge(): void {
  for (const unsubscribe of unsubscribeFns.values()) {
    unsubscribe();
  }
  handlers.clear();
  stateHandlers.clear();
  timelineResetHandlers.clear();
  unsubscribeFns.clear();
  lastSequenceBySession.clear();
  lastAcceptedFrameAt.clear();
  droppedFrameLoggedAt.clear();
  acceptedSequencesBySession.clear();
}
