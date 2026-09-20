import type { AgentKind } from './session';

export type WorkTaskStatus =
  | 'todo'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'awaiting_input'
  | 'review'
  | 'merging'
  | 'done'
  | 'failed'
  | 'canceled';

export interface WorkTask {
  id: string;
  projectId: string;
  title: string;
  instruction: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  workBranch: string | null;
  worktreePath: string | null;
  status: WorkTaskStatus;
  failureReason: string | null;
  lastError: string | null;
  runSeq: number;
  sortOrder: number;
  sessionId: string | null;
  resultSummary: string | null;
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  mergeCommit: string | null;
  completionKind: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  settledAt: string | null;
  finishedAt: string | null;
}

export interface WorkTaskInput {
  title: string;
  instruction: string;
  projectId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
}


/** PATCH /work-tasks/{id} 的部分更新载荷。 */
export type WorkTaskPatch = Partial<WorkTaskInput>;

/** GET /work-tasks/{id}/events 的时间线事件行（daemon 序列化为 camelCase）。 */
export interface WorkTaskEvent {
  id: number;
  taskId: string;
  kind: string;
  detail: string | null;
  createdAt: string;
}
