import { useCallback, useEffect, useState } from 'react';

import { AutomationEditor } from './AutomationEditor';
import { AutomationLanding } from './AutomationLanding';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import type { ScheduledTaskDraft } from '../../types/scheduledTask';

interface AutomationPanelProps {
  taskId: string | null;
  onTaskIdChange: (taskId: string | null) => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

export function AutomationPanel({ taskId, onTaskIdChange, onOpenSession }: AutomationPanelProps) {
  const fetchTasks = useScheduledTaskStore((state) => state.fetchTasks);
  const [newDraft, setNewDraft] = useState<ScheduledTaskDraft | null>(null);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleCreate = useCallback((draft: ScheduledTaskDraft) => {
    setNewDraft(draft);
    onTaskIdChange('new');
  }, [onTaskIdChange]);

  const handleSelectTask = useCallback((id: string) => {
    setNewDraft(null);
    onTaskIdChange(id);
  }, [onTaskIdChange]);

  const handleBack = useCallback(() => {
    setNewDraft(null);
    onTaskIdChange(null);
    fetchTasks();
  }, [onTaskIdChange, fetchTasks]);

  const editingTaskId = taskId === 'new' ? null : taskId;

  const panelContent = taskId ? (
    <AutomationEditor
      taskId={editingTaskId}
      initialDraft={taskId === 'new' ? newDraft : null}
      onBack={handleBack}
      onOpenSession={onOpenSession}
    />
  ) : (
    <AutomationLanding
      onCreate={handleCreate}
      onSelectTask={handleSelectTask}
    />
  );

  return (
    <div className="mx-auto h-full w-full max-w-4xl">
      {panelContent}
    </div>
  );
}
