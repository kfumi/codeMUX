/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AutomationLanding } from './AutomationLanding';

vi.mock('../../stores/scheduledTaskStore', () => ({
  useScheduledTaskStore: (selector: (state: {
    tasks: Array<{ id: string; title: string; projectId: string; nextRunAt: string; enabled: boolean }>;
    setEnabled: ReturnType<typeof vi.fn>;
    runTaskNow: ReturnType<typeof vi.fn>;
  }) => unknown) => selector({
    tasks: [{
      id: 'task-1',
      title: '每日简报',
      projectId: 'project-1',
      nextRunAt: '2026-08-28T09:00:00+08:00',
      enabled: true,
      runCount: 1,
      scheduleKind: 'hourly',
      scheduleTime: '00:00',
      weeklyWeekday: null,
      weeklyWeekdays: null,
      monthlyDay: null,
      timezone: '+08:00',
    }],
    setEnabled: vi.fn(),
    runTaskNow: vi.fn(),
    deleteTask: vi.fn(),
  }),
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: null }) => unknown) => selector({ config: null }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ projects: [{ id: 'project-1', name: 'demo' }] }),
}));

describe('AutomationLanding', () => {
  it('filters tasks and opens create flow', () => {
    const onCreate = vi.fn();
    const onSelectTask = vi.fn();

    render(<AutomationLanding onCreate={onCreate} onSelectTask={onSelectTask} />);

    expect(screen.getByText('每日简报')).toBeTruthy();
    expect(screen.getByText('已运行 1 次')).toBeTruthy();
    expect(screen.getByRole('button', { name: '每日简报 操作' })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('搜索定时任务'), {
      target: { value: '不存在' },
    });
    expect(screen.queryByText('每日简报')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(onCreate).toHaveBeenCalled();
  });
});
