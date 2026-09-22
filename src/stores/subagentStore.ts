import { create } from 'zustand';

import { isCodeMuxSubagentTimelineEvent, isCodeMuxSubagentUpsertEvent, type SubagentStatus } from '@/lib/codeMuxProtocol';
import { useSidePanelStore } from './sidePanelStore';

export type { SubagentStatus };

export interface SubagentDescriptor {
  subagentId: string;
  provider: string;
  title?: string | null;
  description?: string | null;
  status: SubagentStatus;
  toolCallId?: string | null;
  subtitle?: string | null;
  updatedAt: number;
}

export interface SessionSubagentsState {
  /** Insertion order of descriptor arrival. */
  order: string[];
  descriptors: Record<string, SubagentDescriptor>;
  /** Raw inner CodeMUX events keyed by subagent id, in timeline order. */
  events: Record<string, Record<string, unknown>[]>;
  /** event_id dedupe across hydration + live delivery. */
  seenEventIds: Record<string, Set<string>>;
}

interface SubagentState {
  sessions: Record<string, SessionSubagentsState>;
  /**
   * True while the async flow is unsettled even though no descriptor is
   * running anymore: the last child just went terminal and the parent is
   * about to be woken for its summary turn. Cleared by the flow's terminal
   * event (real or synthesized) or by a new prompt.
   */
  continuationPending: Record<string, boolean>;
  applyUpsert: (sessionId: string, event: { subagent_id: string; provider?: string; title?: string | null; description?: string | null; status?: SubagentStatus; tool_call_id?: string | null; subtitle?: string | null }) => void;
  markContinuationSettled: (sessionId: string) => void;
  appendEvent: (sessionId: string, subagentId: string, event: Record<string, unknown>, eventId?: string) => void;
  replaceSession: (sessionId: string, payload: { subagents: Array<Record<string, unknown>>; timelines: Record<string, Array<Record<string, unknown>>> }) => void;
  clearSession: (sessionId: string) => void;
  openInSidePanel: (sessionId: string, subagentId: string) => void;
  routeSubagentSidecarEvent: (raw: string | Record<string, unknown>, sessionId: string) => boolean;
}

function emptySessionState(): SessionSubagentsState {
  return { order: [], descriptors: {}, events: {}, seenEventIds: {} };
}

function sessionState(sessions: Record<string, SessionSubagentsState>, sessionId: string): SessionSubagentsState {
  return sessions[sessionId] ?? emptySessionState();
}

export function subagentTabTitle(descriptor: SubagentDescriptor | undefined): string {
  return descriptor?.description || descriptor?.title || '子智能体';
}

function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}
/** 工具帧的 `tool_use_id`（缺失或非字符串记空串）。 */
function toolUseIdOf(event: Record<string, unknown> | undefined): string {
  const value = event?.tool_use_id;
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/**
 * 同一个 `tool_use_id` 的重复工具帧是**输入刷新**，不是新的一步。
 *
 * OpenCode 对同一个 tool part 先发 `input: {}` 的 pending 帧、再发补全 input 的 running 帧
 * （各自新 `event_id`），渲染层据此刷新已有卡片的参数而不是多画一张卡
 * （`convertAgentEvents` 的 `resolveExistingToolCallPart`）。时间线若把两帧都留下，
 * 卡片上的步骤数就会翻倍，所以这里就地刷新、不追加。
 *
 * 只认 `tool_started`：`tool_finished` 一次调用只来一条，重复到达由 `event_id` 去重兜住。
 */
function findToolRefreshIndex(
  timeline: Record<string, unknown>[],
  event: Record<string, unknown>,
): number {
  if (event.type !== 'tool_started') return -1;
  const toolUseId = toolUseIdOf(event);
  if (toolUseId.length === 0) return -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.type === 'tool_started' && toolUseIdOf(entry) === toolUseId) return index;
  }
  return -1;
}

/** 就地刷新：保住原位置与原 `event_id`（一次调用一个身份），工具参数按新帧合并。 */
function mergeToolRefresh(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const existingInput = existing.input;
  const incomingInput = incoming.input;
  const isMergeable = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
  return {
    ...existing,
    ...incoming,
    input: isMergeable(existingInput) && isMergeable(incomingInput)
      ? { ...existingInput, ...incomingInput }
      : incoming.input,
    event_id: existing.event_id ?? incoming.event_id,
  };
}

export const useSubagentStore = create<SubagentState>((set, get) => ({
  sessions: {},
  continuationPending: {},

  markContinuationSettled: (sessionId) => {
    set((state) => state.continuationPending[sessionId]
      ? { continuationPending: { ...state.continuationPending, [sessionId]: false } }
      : state);
  },

  applyUpsert: (sessionId, event) => {
    if (!sessionId || !event.subagent_id) return;
    set((state) => {
      const current = sessionState(state.sessions, sessionId);
      const existing = current.descriptors[event.subagent_id];
      // Sticky rule: a terminal descriptor never goes back to running
      // (mirrors the Rust upsert semantics).
      const status: SubagentStatus = existing
        && isTerminalSubagentStatus(existing.status)
        && (event.status === 'running' || event.status === undefined)
        ? existing.status
        : event.status ?? existing?.status ?? 'running';
      const descriptor: SubagentDescriptor = {
        subagentId: event.subagent_id,
        provider: existing?.provider ?? event.provider ?? 'claude',
        title: event.title !== undefined ? event.title : existing?.title ?? null,
        description: event.description !== undefined ? event.description : existing?.description ?? null,
        status,
        toolCallId: event.tool_call_id !== undefined ? event.tool_call_id : existing?.toolCallId ?? event.subagent_id,
        subtitle: event.subtitle !== undefined ? event.subtitle : existing?.subtitle ?? null,
        updatedAt: Date.now(),
      };
      const nextDescriptors = { ...current.descriptors, [event.subagent_id]: descriptor };
      // Arm the continuation wait when the last running child goes terminal:
      // the parent is about to be woken for its summary turn. A new (or still
      // running) child disarms it. 只有正常完成才等待汇总——失败/取消(用户
      // 停止、子智能体挂掉)不会触发汇总回合,继续等待只会卡住后续发送。
      const hadRunning = Object.values(current.descriptors).some((entry) => entry?.status === 'running');
      const hasRunning = Object.values(nextDescriptors).some((entry) => entry?.status === 'running');
      const lastChildCompleted = event.status === 'completed';
      const continuationPending = hasRunning
        ? false
        : hadRunning
          ? lastChildCompleted
          : state.continuationPending[sessionId] ?? false;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            order: existing ? current.order : [...current.order, event.subagent_id],
            descriptors: nextDescriptors,
            events: current.events,
            seenEventIds: current.seenEventIds,
          },
        },
        continuationPending: { ...state.continuationPending, [sessionId]: continuationPending },
      };
    });
  },

  appendEvent: (sessionId, subagentId, event, eventId) => {
    if (!sessionId || !subagentId) return;
    const dedupeId = typeof eventId === 'string' && eventId.length > 0
      ? eventId
      : typeof (event as { event_id?: unknown }).event_id === 'string'
        ? (event as { event_id: string }).event_id
        : undefined;
    set((state) => {
      const current = sessionState(state.sessions, sessionId);
      const seen = current.seenEventIds[subagentId] ?? new Set<string>();
      if (dedupeId && seen.has(dedupeId)) {
        return state;
      }
      const nextSeen = new Set(seen);
      if (dedupeId) nextSeen.add(dedupeId);
      // 同一 `tool_use_id` 的重复帧是输入刷新：就地刷新已有那一帧，不追加新的一帧。
      const timeline = current.events[subagentId] ?? [];
      const refreshIndex = findToolRefreshIndex(timeline, event);
      const nextTimeline = refreshIndex >= 0
        ? timeline.map((entry, index) => (index === refreshIndex ? mergeToolRefresh(entry, event) : entry))
        : [...timeline, event];
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            events: {
              ...current.events,
              [subagentId]: nextTimeline,
            },
            seenEventIds: { ...current.seenEventIds, [subagentId]: nextSeen },
          },
        },
      };
    });
  },

  replaceSession: (sessionId, payload) => {
    const descriptors: Record<string, SubagentDescriptor> = {};
    const order: string[] = [];
    for (const raw of Array.isArray(payload?.subagents) ? payload.subagents : []) {
      const subagentId = typeof (raw as { subagentId?: unknown }).subagentId === 'string'
        ? (raw as { subagentId: string }).subagentId
        : typeof (raw as { subagent_id?: unknown }).subagent_id === 'string'
          ? (raw as { subagent_id: string }).subagent_id
          : undefined;
      if (!subagentId) continue;
      order.push(subagentId);
      descriptors[subagentId] = {
        subagentId,
        provider: typeof (raw as { provider?: unknown }).provider === 'string' ? (raw as { provider: string }).provider : 'claude',
        title: ((raw as { title?: unknown }).title as string | null | undefined) ?? null,
        description: ((raw as { description?: unknown }).description as string | null | undefined) ?? null,
        status: ((raw as { status?: unknown }).status as SubagentStatus) ?? 'failed',
        toolCallId: ((raw as { toolCallId?: unknown }).toolCallId as string | null | undefined) ?? subagentId,
        subtitle: ((raw as { subtitle?: unknown }).subtitle as string | null | undefined) ?? null,
        updatedAt: Date.now(),
      };
    }
    const events: Record<string, Record<string, unknown>[]> = {};
    const seenEventIds: Record<string, Set<string>> = {};
    for (const [subagentId, list] of Object.entries(payload?.timelines ?? {})) {
      if (!Array.isArray(list)) continue;
      events[subagentId] = list;
      const ids = new Set<string>();
      for (const event of list) {
        const id = (event as { event_id?: unknown }).event_id;
        if (typeof id === 'string') ids.add(id);
      }
      seenEventIds[subagentId] = ids;
    }
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          order,
          descriptors: { ...descriptors },
          events,
          seenEventIds,
        },
      },
      // Hydrated history is settled by definition — only live upserts may arm
      // the continuation wait.
      continuationPending: { ...state.continuationPending, [sessionId]: false },
    }));
  },

  clearSession: (sessionId) => {
    set((state) => {
      const nextPending = { ...state.continuationPending };
      delete nextPending[sessionId];
      if (!state.sessions[sessionId]) {
        return Object.keys(nextPending).length === Object.keys(state.continuationPending).length
          ? state
          : { continuationPending: nextPending };
      }
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions, continuationPending: nextPending };
    });
  },

  openInSidePanel: (sessionId, subagentId) => {
    const descriptor = get().sessions[sessionId]?.descriptors[subagentId];
    useSidePanelStore.getState().openSubagentTab(sessionId, subagentId, subagentTabTitle(descriptor), descriptor?.status);
  },

  /**
   * Route a raw sidecar event string into this store. Returns true when the
   * event was a subagent event (caller must not append it to the parent
   * timeline). Unknown event shapes are ignored.
   */
  routeSubagentSidecarEvent: (raw, sessionId) => {
    // Callers on the WebSocket path already hold the parsed event; only the
    // legacy string producers need a parse here.
    let data: unknown;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return false;
      }
    } else {
      data = raw;
    }
    if (isCodeMuxSubagentUpsertEvent(data)) {
      get().applyUpsert(sessionId, data);
      return true;
    }
    if (isCodeMuxSubagentTimelineEvent(data)) {
      get().appendEvent(sessionId, data.subagent_id, data.event, data.event_id);
      return true;
    }
    return false;
  },
}));
