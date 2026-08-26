import type { AgentKind, AgentPlanMode, ReasoningEffort } from './session';
import type { AgentPermissionConfig } from '../lib/agentPermissions';

export type ScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'awaiting_input' | 'skipped';
export type SkipReason = 'overlap' | 'concurrency_limit' | 'project_missing';

export interface ScheduledTask {
  id: string;
  title: string;
  instruction: string;
  projectId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionConfig: string;
  planMode: AgentPlanMode;
  scheduleKind: ScheduleKind;
  scheduleTime: string;
  weeklyWeekday: number | null;
  monthlyDay: number | null;
  timezone: string;
  delivery: 'new_session';
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: TaskRunStatus;
  skipReason: SkipReason | null;
  error: string | null;
}

export interface ScheduledTaskInput {
  title: string;
  instruction: string;
  projectId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionConfig: string;
  planMode: AgentPlanMode;
  scheduleKind: ScheduleKind;
  scheduleTime: string;
  weeklyWeekday: number | null;
  monthlyDay: number | null;
  timezone?: string;
  enabled: boolean;
}

export interface ScheduledTaskDraft {
  title: string;
  instruction: string;
  projectId: string | null;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort;
  permissionConfig: AgentPermissionConfig;
  planMode: AgentPlanMode;
  scheduleKind: ScheduleKind;
  scheduleTime: string;
  weeklyWeekday: number;
  monthlyDay: number;
  enabled: boolean;
}
