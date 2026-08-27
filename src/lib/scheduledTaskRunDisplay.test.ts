import { describe, expect, it } from 'vitest';

import type { TaskRun } from '../types/scheduledTask';
import { formatRunDuration, getRunStatusPresentation } from './scheduledTaskRunDisplay';

const baseRun: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  scheduledFor: '2026-08-28T01:06:00+08:00',
  startedAt: '2026-08-28T01:06:00+08:00',
  finishedAt: '2026-08-28T01:06:07+08:00',
  status: 'completed',
  skipReason: null,
  error: null,
};

describe('scheduledTaskRunDisplay', () => {
  it('formats duration in seconds', () => {
    expect(formatRunDuration(baseRun)).toBe('7s');
  });

  it('maps completed status to success label', () => {
    expect(getRunStatusPresentation('completed').label).toBe('成功');
  });
});
