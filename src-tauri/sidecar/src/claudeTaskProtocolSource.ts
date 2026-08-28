import type { CodeMuxSubagentEvent } from './codeMuxProtocol.js';
import { observeClaudeSdkMessage } from './claudeSubagentObservations.js';
import {
  createEmptySubagentFoldState,
  foldCancelRunningForegroundTasks,
  foldFailRunningTasks,
  foldSubagentObservations,
  hasRunningSubagents,
  type SubagentFoldContext,
  type SubagentFoldState,
} from './claudeSubagentFold.js';

export type SubagentObserveContext = {
  sessionId?: string;
};

/**
 * Claude task protocol adapter (spec seam 1): interprets task_started /
 * task_updated / task_progress / task_notification frames and sidechain
 * traffic, resolving task_id ↔ canonical subagent id aliases. The canonical
 * subagent id is the first parent-side tool_use_id of the announcement, which
 * is also the Agent/Task card's tool_call_id.
 */
export class ClaudeTaskProtocolSource {
  private foldState: SubagentFoldState = createEmptySubagentFoldState();

  observe(sdkMessage: Record<string, unknown>, context: SubagentObserveContext = {}): CodeMuxSubagentEvent[] {
    const observations = observeClaudeSdkMessage(sdkMessage);
    if (observations.length === 0) return [];
    const result = foldSubagentObservations(observations, this.foldState, this.context(context));
    this.foldState = result.state;
    return result.events;
  }

  /** Resolve any announcement tool_use_id (canonical or alias) to the canonical subagent id. */
  resolveSubagentId(toolUseId: string): string | undefined {
    return this.foldState.aliasToSubagent[toolUseId];
  }

  hasRunningTasks(): boolean {
    return hasRunningSubagents(this.foldState);
  }

  runningSubagentIds(): string[] {
    return Object.values(this.foldState.subagents)
      .filter((entry) => entry.descriptor.status === 'running')
      .map((entry) => entry.subagentId);
  }

  /** Parent turn result: cancel only explicitly-foreground running children. */
  cancelRunningForegroundTasks(context: SubagentObserveContext = {}): CodeMuxSubagentEvent[] {
    const result = foldCancelRunningForegroundTasks(this.foldState, this.context(context));
    this.foldState = result.state;
    return result.events;
  }

  /** User Stop / query abort / process loss: all running children (incl. backgrounded) fail. */
  failRunningTasks(context: SubagentObserveContext = {}): CodeMuxSubagentEvent[] {
    const result = foldFailRunningTasks(this.foldState, this.context(context));
    this.foldState = result.state;
    return result.events;
  }

  /** Session teardown only. */
  reset(): void {
    this.foldState = createEmptySubagentFoldState();
  }

  private context(context: SubagentObserveContext): SubagentFoldContext {
    return { ...(context.sessionId ? { sessionId: context.sessionId } : {}) };
  }
}
