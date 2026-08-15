import { useEffect, useState } from 'react';
import { ChevronRight, Plus, RefreshCw } from 'lucide-react';

import { CreateSessionSheet } from './CreateSessionSheet';
import { listProjects, listSessions, type MobileProject, type MobileSession } from '../lib/api';
import { cacheSessionList, clearConnection, loadCachedSessionList, type CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface SessionListProps {
  connection: CompanionConnection;
  onOpenSession: (sessionId: string) => void;
  onDisconnected: () => void;
}

export function SessionList({ connection, onOpenSession, onDisconnected }: SessionListProps) {
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [projects, setProjects] = useState<MobileProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSessions, nextProjects] = await Promise.all([
        listSessions(connection),
        listProjects(connection),
      ]);
      setSessions(nextSessions);
      setProjects(nextProjects);
      await cacheSessionList({
        updatedAt: new Date().toISOString(),
        sessions: nextSessions.map((session) => ({
          id: session.id,
          title: session.title,
          agent_kind: session.agent_kind,
          updated_at: session.updated_at,
        })),
      });
    } catch (err) {
      const cached = await loadCachedSessionList();
      if (cached) {
        setSessions(cached.sessions as MobileSession[]);
        setError('离线模式：显示缓存会话列表');
      } else {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [connection.baseUrl, connection.token]);

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-white/10 px-5 pb-4 pt-10">
        <div>
          <div className="text-lg font-semibold">会话</div>
          <div className="text-xs text-slate-400">{connection.baseUrl}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/10 p-2"
            onClick={() => void refresh()}
            aria-label="刷新"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/10 p-2"
            onClick={() => setCreateOpen(true)}
            aria-label="新建会话"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error ? <div className="mx-5 mt-4 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{error}</div> : null}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {sessions.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-400">
            暂无未归档会话
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="flex w-full items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-left"
                onClick={() => onOpenSession(session.id)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{session.title}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {session.agent_kind}
                    {session.model ? ` · ${session.model}` : ''}
                    {' · '}
                    {new Date(session.updated_at).toLocaleString()}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-white/10 px-5 py-4">
        <button
          type="button"
          className="w-full rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300"
          onClick={() => {
            void clearConnection().then(onDisconnected);
          }}
        >
          断开配对
        </button>
      </footer>

      <CreateSessionSheet
        connection={connection}
        projects={projects}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(sessionId) => {
          void refresh().then(() => onOpenSession(sessionId));
        }}
      />
    </div>
  );
}
