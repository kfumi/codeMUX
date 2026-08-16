import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Plus, RefreshCw } from 'lucide-react';

import { CreateSessionSheet } from './CreateSessionSheet';
import { DesktopOfflineOverlay } from './DesktopOfflineOverlay';
import { useDesktopReachability } from '../hooks/useDesktopReachability';
import { listProjects, listSessions, isAuthError, revokePairing, type MobileProject, type MobileSession } from '../lib/api';
import { cacheSessionList, clearConnection, type CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface SessionListProps {
  connection: CompanionConnection;
  onOpenSession: (sessionId: string) => void;
  onDisconnected: (reason?: string) => void;
}

export function SessionList({ connection, onOpenSession, onDisconnected }: SessionListProps) {
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [projects, setProjects] = useState<MobileProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const handleAuthFailure = useCallback(() => {
    void (async () => {
      await clearConnection();
      onDisconnected('桌面端已撤销此设备或配对已失效，请重新配对。');
    })();
  }, [onDisconnected]);

  const handleUnpair = useCallback(() => {
    void (async () => {
      try {
        await revokePairing(connection);
      } catch {
        // Best effort: still clear local credentials if desktop is unreachable.
      }
      await clearConnection();
      onDisconnected();
    })();
  }, [connection, onDisconnected]);

  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const {
    offline,
    detail,
    reconnecting,
    reconnect,
    reportUnreachable,
  } = useDesktopReachability(connection, {
    onAuthFailure: handleAuthFailure,
    onRecovered: () => {
      void refreshRef.current();
    },
  });

  const refresh = useCallback(async () => {
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
      if (isAuthError(err)) {
        handleAuthFailure();
        return;
      }
      reportUnreachable(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, handleAuthFailure, reportUnreachable]);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!offline) {
        void refresh();
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [connection.baseUrl, connection.token, offline, refresh]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="mobile-safe-header flex shrink-0 items-center justify-between border-b border-border px-5">
        <div>
          <div className="text-lg font-semibold">会话</div>
          <div className="text-xs text-muted-foreground">{connection.baseUrl}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={() => void refresh()}
            aria-label="刷新"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            className="rounded-md border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={() => setCreateOpen(true)}
            aria-label="新建会话"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && !offline ? (
        <div className="mx-5 mt-4 rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm text-muted-foreground">
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {sessions.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            暂无未归档会话
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-[hsl(var(--surface-2))] px-4 py-3 text-left transition-colors hover:bg-muted/40"
                onClick={() => onOpenSession(session.id)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{session.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {session.agent_kind}
                    {session.model ? ` · ${session.model}` : ''}
                    {' · '}
                    {new Date(session.updated_at).toLocaleString()}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="w-full rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={() => {
            void handleUnpair();
          }}
        >
          断开配对
        </button>
        <p className="mt-2 text-center text-[10px] text-muted-foreground/60">
          构建 {__MOBILE_BUILD_ID__.slice(0, 19).replace('T', ' ')}
        </p>
      </footer>

      <CreateSessionSheet
        connection={connection}
        projects={projects}
        open={createOpen && !offline}
        onClose={() => setCreateOpen(false)}
        onCreated={(sessionId) => {
          void refresh().then(() => onOpenSession(sessionId));
        }}
      />

      {offline ? (
        <DesktopOfflineOverlay
          detail={detail ?? error}
          reconnecting={reconnecting}
          onReconnect={() => {
            void reconnect().then((recovered) => {
              if (recovered) {
                void refresh();
              }
            });
          }}
          onUnpair={handleUnpair}
        />
      ) : null}
    </div>
  );
}
