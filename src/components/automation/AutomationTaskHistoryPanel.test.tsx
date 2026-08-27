/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { TaskRun } from '../../types/scheduledTask';
import { AutomationTaskHistoryPanel } from './AutomationTaskHistoryPanel';

const run: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  scheduledFor: '2026-08-28T09:00:00+08:00',
  startedAt: '2026-08-28T09:00:00+08:00',
  finishedAt: '2026-08-28T09:01:00+08:00',
  status: 'completed',
  skipReason: null,
  error: null,
};

const deleteRun = vi.fn().mockResolvedValue(undefined);

vi.mock('../../stores/scheduledTaskStore', () => ({
  useScheduledTaskStore: (selector: (state: { deleteRun: typeof deleteRun }) => unknown) =>
    selector({ deleteRun }),
}));

function openRowMenu() {
  const trigger = screen.getByRole('button', { name: '记录操作' });
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
  fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
  fireEvent.click(trigger);
}

describe('AutomationTaskHistoryPanel', () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = '';
  });

  it('opens delete confirm after the row menu closes so the dialog stays clickable', async () => {
    const onOutside = vi.fn();
    render(
      <>
        <AutomationTaskHistoryPanel
          taskId="task-1"
          projectId="project-1"
          runs={[run]}
          onOpenSession={vi.fn()}
        />
        <button type="button" onClick={onOutside}>
          outside action
        </button>
      </>,
    );

    openRowMenu();
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.body.style.pointerEvents).not.toBe('none');

    fireEvent.click(screen.getByRole('menuitem', { name: '删除记录' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: '删除记录' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.body.style.pointerEvents).not.toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'outside action' }));
    expect(onOutside).toHaveBeenCalled();
  });
});
