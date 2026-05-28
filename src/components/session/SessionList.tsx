import { useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { SessionItem } from './SessionItem';

export function SessionList() {
  const { sessions, activeSessionId, fetchSessions, setActiveSession, deleteSession } = useSessionStore();

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return (
    <div className="space-y-1 p-2">
      {sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => setActiveSession(session.id)}
          onDelete={() => deleteSession(session.id)}
        />
      ))}
      {sessions.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">暂无对话</p>
      )}
    </div>
  );
}
