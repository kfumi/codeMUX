import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Palette, Plus, RefreshCw } from 'lucide-react';
import { summarizeActiveConnection } from '@shared/lib/companion-connection';

import { CreateSessionSheet } from './CreateSessionSheet';
import { DesktopOfflineOverlay } from './DesktopOfflineOverlay';
import { ThemeSettings } from './ThemeSettings';
import { useDesktopReachability } from '../hooks/useDesktopReachability';
import { listProjects, listSessions, isAuthError, type MobileProject, type MobileSession } from '../lib/api';
import { cacheSessionList, clearConnection, type CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface SessionListProps {
  connection: CompanionConnection;
  onOpenSession: (session: MobileSession) => void;
  onDisconnected: (reason?: string) => void;
}

export function SessionList({ connection, onOpenSession, onDisconnected }: SessionListProps) {
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [projects, setProjects] = useState<MobileProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [connectionSummary, setConnectionSummary] = useState(connection.label ?? connection.desktopId);

  const handleAuthFailure = useCallback(() => {
    void (async () => {
      await clearConnection();
      onDisconnected('桌面端已撤销此设备或配对已失效，请重新配对。');
    })();
  }, [onDisconnected]);

  const refreshRef = useRef<() => Promise<MobileSession[]>>(async () => []);

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

  const refresh = useCallback(async (): Promise<MobileSession[]> => {
    setLoading(true);
    setError(null);
    let nextSessions: MobileSession[] = [];
    try {
      const [loadedSessions, nextProjects] = await Promise.all([
        listSessions(connection),
        listProjects(connection),
      ]);
      nextSessions = loadedSessions;
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
        return [];
      }
      reportUnreachable(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    return nextSessions;
  }, [connection, handleAuthFailure, reportUnreachable]);

  refreshRef.current = refresh;

  useEffect(() => {
    void (async () => {
      const { buildReachabilityMap } = await import('@shared/lib/companion-connection');
      const reachability = await buildReachabilityMap(connection);
      setConnectionSummary(summarizeActiveConnection(connection, reachability));
    })();
  }, [connection]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!offline) {
        void refresh();
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [connection.desktopId, connection.token, offline, refresh]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="mobile-safe-header flex shrink-0 items-center justify-between border-b border-border px-5">
        <div>
          <div className="text-lg font-semibold">会话</div>
          <div className="text-xs text-muted-foreground">{connectionSummary}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={() => setThemeOpen(true)}
            aria-label="主题设置"
          >
            <Palette className="h-4 w-4" />
          </button>
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
                onClick={() => onOpenSession(session)}
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

      <CreateSessionSheet
        connection={connection}
        projects={projects}
        open={createOpen && !offline}
        onClose={() => setCreateOpen(false)}
        onCreated={(sessionId) => {
          void refresh().then((nextSessions) => {
            const created = nextSessions.find((session) => session.id === sessionId);
            if (created) onOpenSession(created);
          });
        }}
      />

      {themeOpen ? <ThemeSettings onClose={() => setThemeOpen(false)} /> : null}

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
        />
      ) : null}
    </div>
  );
}
