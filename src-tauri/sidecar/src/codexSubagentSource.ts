import type { CodeMuxSubagentEvent } from './codeMuxProtocol.js';
import type { SubagentObservation } from './claudeSubagentObservations.js';
import {
  createEmptySubagentFoldState,
  foldFailRunningTasks,
  foldSubagentObservations,
  hasRunningSubagents,
  type SubagentFoldContext,
  type SubagentFoldState,
} from './claudeSubagentFold.js';
import {
  agentPathDisplayName,
  aggregateCollabAgentStatus,
  createCodexChildProjectionState,
  extractCodexCollabItem,
  extractCodexSubAgentActivity,
  mapCodexChildTurnStatus,
  projectCodexChildNotification,
  type CodexChildProjectionState,
  type CodexSubAgentActivityInfo,
} from './codexSubagentObservations.js';
import { isSpawnCollabTool } from './runtimeEvents.js';
/**
 * A subagent declaration the runtime renders as the parent-thread delegation
 * card: the declaration's call id (also the track id) plus the agent path that
 * names it.
 */
export type CodexSubagentDeclaration = {
  callId: string;
  agentPath: string | null;
};

/**
 * Codex collab-agent adapter (spec seam 1, stateful half). Declares subagent
 * tracks from two declaration sources — parent-thread `collabAgentToolCall`
 * spawn items (variant A) and `subAgentActivity` items on the declaring thread
 * (variant B: codex forks the child thread from the parent history and emits
 * no spawn item at all) — binds child agent threads to their canonical
 * subagent id, and routes child-thread notifications (which the app-server
 * pushes on the same JSON-RPC connection, tagged with the child `threadId`)
 * into the shared observation fold. Only a spawn creates a track: `wait` /
 * `sendInput` / `resumeAgent` / `closeAgent` are orchestration and can only
 * aggregate onto a child a spawn already declared.
 *
 * Child notifications frequently arrive before the declaration claims the
 * thread; unclaimed traffic is buffered per thread and replayed in order once
 * the declaration registers the route (Paseo's pending-sub-agent pattern,
 * with bounded memory).
 */

const PENDING_MAX_THREADS = 32;
const PENDING_MAX_PER_THREAD = 128;

export type CodexSubagentContext = {
  sessionId?: string;
  workdir?: string;
};

export type CodexThreadRoute = 'parent' | 'child' | 'pending';

type PendingNotification = { method: string; params: Record<string, unknown> };

export class CodexSubagentSource {
  private foldState: SubagentFoldState = createEmptySubagentFoldState();
  /** Child agent thread id → canonical subagent id (the collab item id). */
  private readonly childToSubagent = new Map<string, string>();
  /** Child thread id → projection state (streaming item ids). */
  private readonly childStates = new Map<string, CodexChildProjectionState>();
  /** Unclaimed child-thread notifications, replayed once the route registers. */
  private readonly pendingByThread = new Map<string, PendingNotification[]>();
  /**
   * Spawn declarations whose child threads were not announced yet (codex
   * emits `item/started` for a spawn twice: first without
   * `receiverThreadIds`, again once the child threads exist). subagent id →
   * prompt, used to merge the second announcement into the first track.
   */
  private readonly unresolvedSpawns = new Map<string, string>();

  /** Classify a notification's threadId before any parent-turn projection. */
  routeThreadId(threadId: string | undefined, parentThreadId: string | null): CodexThreadRoute {
    if (!threadId || threadId === parentThreadId) return 'parent';
    return this.childToSubagent.has(threadId) ? 'child' : 'pending';
  }

  /**
   * Hold an unclaimed thread's *content* until a declaration registers it.
   * Declarations themselves never come here: this queue trims its oldest entry
   * under pressure, and dropping the declaration would strand everything else.
   */
  private bufferPendingNotification(threadId: string, method: string, params: Record<string, unknown>): void {
    if (!this.pendingByThread.has(threadId)) {
      if (this.pendingByThread.size >= PENDING_MAX_THREADS) return;
      this.pendingByThread.set(threadId, []);
    }
    const queue = this.pendingByThread.get(threadId)!;
    if (queue.length >= PENDING_MAX_PER_THREAD) {
      queue.shift();
    }
    queue.push({ method, params });
  }

  /**
   * Parent-thread collab item (started or completed). `started` declares the
   * track (and registers child routes + replays buffered traffic); both
   * phases carry the `agentsStates` snapshot driving descriptor status.
   */
  observeParentItem(
    rawItem: unknown,
    phase: 'started' | 'completed',
    context: CodexSubagentContext = {},
  ): CodeMuxSubagentEvent[] {
    // `subAgentActivity` is a declaration source in its own right (variant B
    // emits no spawn item at all), so it is read before the collab item path.
    const activity = extractCodexSubAgentActivity(rawItem);
    if (activity) {
      return this.observeActivity(activity, context);
    }
    const collab = extractCodexCollabItem(rawItem);
    if (!collab) return [];

    // Only a spawn launches a child: wait / sendInput / resumeAgent /
    // closeAgent are orchestration and may only aggregate onto a child that a
    // spawn already declared.
    const isSpawn = isSpawnCollabTool(collab.tool);
    const known = this.resolveKnownSubagent(collab.receiverThreadIds);
    const observations: SubagentObservation[] = [];
    let statusTarget: string | undefined = known;
    if (phase === 'started') {
      if (known) {
        // Follow-up collab call (sendInput/wait/closeAgent) to an already
        // routed child: record the item id as an alias, no new track.
        observations.push({
          kind: 'declared',
          taskId: known,
          toolUseIds: [collab.id],
          isWorkflow: false,
          provider: 'codex',
        });
      } else if (isSpawn) {
        const mergeTarget = collab.receiverThreadIds.length > 0
          ? this.findUnresolvedSpawnTarget(collab.prompt)
          : undefined;
        if (mergeTarget) {
          // Re-announced spawn: the first announcement could not register
          // child routes yet (no thread ids on the wire). Merge into it so
          // the track keeps one id, one timeline and one parent card.
          statusTarget = mergeTarget;
          observations.push({
            kind: 'declared',
            taskId: mergeTarget,
            toolUseIds: [collab.id],
            isWorkflow: false,
            provider: 'codex',
          });
        } else {
          statusTarget = collab.id;
          observations.push({
            kind: 'declared',
            taskId: collab.id,
            toolUseIds: [collab.id],
            title: 'Sub-agent',
            ...(collab.prompt ? { prompt: collab.prompt, description: collab.prompt } : {}),
            isWorkflow: false,
            provider: 'codex',
          });
        }
      }
    } else if (isSpawn) {
      // Completion of a spawn announced earlier: the started phase owns the
      // track, this phase only carries the terminal agentsStates snapshot.
      if (statusTarget === undefined) statusTarget = collab.id;
    }
    // Unknown tasks are a no-op for the fold; skipping them here keeps the
    // "no track without a spawn declaration" invariant local to this adapter.
    const status = statusTarget === undefined ? undefined : aggregateCollabAgentStatus(collab);
    if (status && statusTarget !== undefined) {
      observations.push({ kind: 'status', taskId: statusTarget, status });
    }
    if (observations.length === 0) return [];

    const events = this.fold(observations, context);
    const canonical = known
      ?? (statusTarget === undefined ? undefined : this.foldState.taskToSubagent[statusTarget])
      ?? (statusTarget === undefined ? undefined : this.foldState.aliasToSubagent[statusTarget])
      ?? this.foldState.taskToSubagent[collab.id]
      ?? this.foldState.aliasToSubagent[collab.id];
    if (!canonical) return events;

    const descriptor = this.foldState.subagents[canonical]?.descriptor;
    if (descriptor && descriptor.status !== 'running') {
      this.unresolvedSpawns.delete(canonical);
    }

    const replayed: CodeMuxSubagentEvent[] = [];
    for (const threadId of collab.receiverThreadIds) {
      if (!this.childToSubagent.has(threadId)) {
        this.childToSubagent.set(threadId, canonical);
        this.unresolvedSpawns.delete(canonical);
      }
      replayed.push(...this.replayPending(threadId, context));
    }
    if (phase === 'started' && collab.receiverThreadIds.length === 0 && descriptor?.status === 'running') {
      this.unresolvedSpawns.set(canonical, collab.prompt ?? '');
    }
    return [...events, ...replayed];
  }

  /**
   * True when this collab call id is the canonical declaration of a track —
   * the only announcement that renders a parent card.
   */
  isCanonicalDeclaration(callId: string): boolean {
    return this.foldState.taskToSubagent[callId] === callId && !!this.foldState.subagents[callId];
  }

  /** The canonical call id behind a re-announced (alias) collab item, if any. */
  canonicalCallIdFor(callId: string): string | undefined {
    const canonical = this.foldState.aliasToSubagent[callId];
    return canonical && canonical !== callId ? canonical : undefined;
  }

  /**
   * Subagent declaration carried by a *parent-thread* `subAgentActivity` item,
   * when it newly declares a track. This variant emits no collab spawn item, so
   * the runtime synthesizes the parent card from this. Call before observing
   * the item: registering the route is what makes a re-announcement return null
   * and never duplicate the card.
   */
  activityDeclaration(rawItem: unknown): CodexSubagentDeclaration | null {
    const activity = extractCodexSubAgentActivity(rawItem);
    if (!activity || activity.kind !== 'started' || !activity.agentThreadId) return null;
    if (this.childToSubagent.has(activity.agentThreadId)) return null;
    // Same call id under a fresh agent thread: the card for it already exists,
    // and only one `tool_started` may carry a given tool_use_id.
    if (this.foldState.aliasToSubagent[activity.id] || this.foldState.taskToSubagent[activity.id]) {
      return null;
    }
    return { callId: activity.id, agentPath: activity.agentPath };
  }

  /** Route one child-thread notification into the subagent timeline. */
  observeChildNotification(
    method: string,
    params: Record<string, unknown>,
    context: CodexSubagentContext = {},
  ): CodeMuxSubagentEvent[] {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!threadId) return [];
    // A child's own `subAgentActivity` declares *its* children (grandchildren),
    // on the same routine as the parent route. Declarations are never buffered:
    // the pending queue trims its oldest entries, which could silently drop the
    // declaration that the buffered content is waiting for.
    const activity = extractCodexSubAgentActivity(params.item);
    if (activity) {
      return this.observeActivity(activity, context);
    }
    const canonical = this.childToSubagent.get(threadId);
    if (!canonical) {
      // Unclaimed thread: buffer the content until a declaration claims it.
      this.bufferPendingNotification(threadId, method, params);
      return [];
    }

    const observations: SubagentObservation[] = [];
    if (method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : {};
      const status = mapCodexChildTurnStatus(turn.status);
      if (status) {
        observations.push({ kind: 'status', taskId: canonical, status });
      }
    } else {
      const childState = this.childState(threadId);
      const sourceEvents = projectCodexChildNotification(method, params, childState, {
        workdir: context.workdir,
      });
      if (sourceEvents.length > 0) {
        observations.push({ kind: 'timeline', parentToolUseId: canonical, events: sourceEvents });
      }
    }
    if (observations.length === 0) return [];
    return this.fold(observations, context);
  }

  hasRunningTasks(): boolean {
    return hasRunningSubagents(this.foldState);
  }

  /** User Stop / interrupt / transport loss: every running child becomes failed. */
  failRunningTasks(context: CodexSubagentContext = {}): CodeMuxSubagentEvent[] {
    const result = foldFailRunningTasks(this.foldState, this.foldContext(context));
    this.foldState = result.state;
    return result.events;
  }

  /** Session teardown only. */
  reset(): void {
    this.foldState = createEmptySubagentFoldState();
    this.childToSubagent.clear();
    this.childStates.clear();
    this.pendingByThread.clear();
    this.unresolvedSpawns.clear();
  }

  /**
   * `subAgentActivity` declares a track, and the declaration is deliberately
   * independent of the declaring thread's route: variant B announces children
   * this way, and a child announces its own children the same way.
   */
  private observeActivity(
    activity: CodexSubAgentActivityInfo,
    context: CodexSubagentContext,
  ): CodeMuxSubagentEvent[] {
    const threadId = activity.agentThreadId;
    if (!threadId) return [];
    const existing = this.childToSubagent.get(threadId);
    const observations: SubagentObservation[] = [];
    if (activity.kind === 'started') {
      // The declaration proper. Re-announcements (codex mirrors item/started as
      // item/completed, and may reuse the thread under a new call id) merge into
      // the canonical track through this same observation.
      const name = agentPathDisplayName(activity.agentPath);
      observations.push({
        kind: 'declared',
        taskId: existing ?? activity.id,
        toolUseIds: [activity.id],
        ...(name ? { title: name } : {}),
        ...(activity.agentPath ? { subtitle: activity.agentPath } : {}),
        isWorkflow: false,
        provider: 'codex',
      });
    } else if (activity.kind === 'interrupted') {
      // An interruption for an unclaimed thread has no child to cancel, and a
      // track declared only to be canceled is exactly a phantom entry.
      if (!existing) return [];
      observations.push({ kind: 'status', taskId: existing, status: 'canceled' });
    } else if (existing && activity.agentPath) {
      // `interacted` refreshes the declared path, never the lifecycle.
      observations.push({ kind: 'subtitle', taskId: existing, subtitle: activity.agentPath });
    }
    if (observations.length === 0) return [];

    const events = this.fold(observations, context);
    if (existing) return events;
    const canonical = this.foldState.aliasToSubagent[activity.id]
      ?? this.foldState.taskToSubagent[activity.id];
    if (!canonical) return events;
    this.childToSubagent.set(threadId, canonical);
    return [...events, ...this.replayPending(threadId, context)];
  }

  private resolveKnownSubagent(receiverThreadIds: string[]): string | undefined {
    for (const threadId of receiverThreadIds) {
      const canonical = this.childToSubagent.get(threadId);
      if (canonical) return canonical;
    }
    return undefined;
  }

  /**
   * Find the earlier spawn announcement a re-announcement (now carrying the
   * child thread ids) should merge into. Prompt equality disambiguates
   * parallel spawns; a single unresolved candidate is accepted regardless.
   */
  private findUnresolvedSpawnTarget(prompt: string | null): string | undefined {
    const entries = [...this.unresolvedSpawns.entries()];
    if (entries.length === 0) return undefined;
    if (prompt !== null) {
      const byPrompt = entries.filter(([, value]) => value === prompt);
      if (byPrompt.length === 1) return byPrompt[0][0];
      if (byPrompt.length > 1) return undefined;
    }
    return entries.length === 1 ? entries[0][0] : undefined;
  }

  private replayPending(threadId: string, context: CodexSubagentContext): CodeMuxSubagentEvent[] {
    const queue = this.pendingByThread.get(threadId);
    if (!queue || queue.length === 0) return [];
    this.pendingByThread.delete(threadId);
    const events: CodeMuxSubagentEvent[] = [];
    for (const notification of queue.splice(0)) {
      events.push(...this.observeChildNotification(notification.method, notification.params, context));
    }
    return events;
  }

  private childState(threadId: string): CodexChildProjectionState {
    let state = this.childStates.get(threadId);
    if (!state) {
      state = createCodexChildProjectionState();
      this.childStates.set(threadId, state);
    }
    return state;
  }

  private fold(observations: SubagentObservation[], context: CodexSubagentContext): CodeMuxSubagentEvent[] {
    const result = foldSubagentObservations(observations, this.foldState, this.foldContext(context));
    this.foldState = result.state;
    return result.events;
  }

  private foldContext(context: CodexSubagentContext): SubagentFoldContext {
    return {
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      // Collab child tool items can re-arrive with fuller input on completion.
      refreshToolInput: true,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
