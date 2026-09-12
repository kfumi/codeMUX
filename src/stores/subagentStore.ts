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
  routeSubagentSidecarEvent: (raw: string, sessionId: string) => boolean;
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
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            events: {
              ...current.events,
              [subagentId]: [...(current.events[subagentId] ?? []), event],
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
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
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
