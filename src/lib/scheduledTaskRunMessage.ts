import type { TaskRun } from '../types/scheduledTask';

export function getScheduledTaskRunMessage(run: TaskRun): string | null {
  if (run.status === 'skipped' && run.skipReason === 'project_missing') {
    return '项目不可用，已跳过运行';
  }
  if (run.status === 'failed') {
    return run.error ?? '运行失败';
  }
  return null;
}
