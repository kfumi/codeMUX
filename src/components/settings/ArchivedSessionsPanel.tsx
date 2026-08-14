import { useEffect, useMemo, useState } from 'react';
import { Archive, FolderOpen, Search, Trash2, Undo2 } from 'lucide-react';

import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import {
  getSessionDisplayTitle,
  resolveSessionTitle,
  shouldResolveStoredSessionTitle,
} from '../../lib/sessionTitle';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { AGENT_REGISTRY, getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import type { Session } from '../../types/session';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type SortMode = 'updated_at' | 'created_at' | 'title';

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}


function sortSessions(sessions: Session[], sortMode: SortMode): Session[] {
  return [...sessions].sort((a, b) => {
    if (sortMode === 'title') {
      return getSessionDisplayTitle(a.title).localeCompare(getSessionDisplayTitle(b.title), 'zh-Hans-CN');
    }
    const left = Date.parse(sortMode === 'created_at' ? a.created_at : a.updated_at);
    const right = Date.parse(sortMode === 'created_at' ? b.created_at : b.updated_at);
    return right - left;
  });
}

export function ArchivedSessionsPanel() {
  const archivedSessions = useSessionStore((state) => state.archivedSessions);
  const fetchArchivedSessions = useSessionStore((state) => state.fetchArchivedSessions);
  const unarchiveSession = useSessionStore((state) => state.unarchiveSession);
  const deleteSession = useSessionStore((state) => state.deleteSession);
  const updateSessionTitle = useSessionStore((state) => state.updateSessionTitle);
  const projects = useProjectStore((state) => state.projects);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);

  const [keyword, setKeyword] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('updated_at');
  const [projectId, setProjectId] = useState('all');
  const [agentKind, setAgentKind] = useState<'all' | AgentKind>('all');
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [resolvedTitles, setResolvedTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchArchivedSessions();
    fetchProjects();
  }, [fetchArchivedSessions, fetchProjects]);

  useEffect(() => {
    let cancelled = false;
    const sessionsToResolve = archivedSessions.filter((session) => shouldResolveStoredSessionTitle(session.title));
    if (sessionsToResolve.length === 0) return undefined;

    void (async () => {
      const entries = await Promise.all(
        sessionsToResolve.map(async (session) => {
          const resolved = await resolveSessionTitle(session.id, session.agent_kind, session.title);
          if (resolved !== getSessionDisplayTitle(session.title)) {
            void updateSessionTitle(session.id, resolved);
          }
          return [session.id, resolved] as const;
        }),
      );
      if (!cancelled) {
        setResolvedTitles((current) => ({
          ...current,
          ...Object.fromEntries(entries),
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [archivedSessions, updateSessionTitle]);

  const filteredSessions = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    const result = archivedSessions.filter((session) => {
      const displayTitle = resolvedTitles[session.id] ?? getSessionDisplayTitle(session.title);
      const agentLabel = getAgentDefinition(session.agent_kind)?.label ?? session.agent_kind;
      const matchesKeyword =
        !query ||
        displayTitle.toLowerCase().includes(query) ||
        session.id.toLowerCase().includes(query) ||
        agentLabel.toLowerCase().includes(query);
      const matchesProject = projectId === 'all' || session.project_id === projectId;
      const matchesAgent = agentKind === 'all' || session.agent_kind === agentKind;
      return matchesKeyword && matchesProject && matchesAgent;
    });
    return sortSessions(result, sortMode);
  }, [archivedSessions, keyword, projectId, agentKind, sortMode, resolvedTitles]);

  const handleDelete = async (session: Session) => {
    await deleteSession(session.id);
    setDeleteTarget(null);
  };

  const handleClearAll = async () => {
    setIsClearing(true);
    try {
      for (const session of filteredSessions) {
        await deleteSession(session.id);
      }
      setClearConfirm(false);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button
          variant="destructive"
          size="sm"
          className="gap-2"
          onClick={() => setClearConfirm(true)}
          disabled={filteredSessions.length === 0}
        >
          <Trash2 className="h-4 w-4" />
          全部删除
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="relative md:col-span-2 xl:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索已归档对话"
            className="pl-9"
          />
        </div>
        <Select value={agentKind} onValueChange={(value) => setAgentKind(value as 'all' | AgentKind)}>
          <SelectTrigger>
            <SelectValue placeholder="智能体" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部智能体</SelectItem>
            {AGENT_REGISTRY.map((agent) => (
              <SelectItem key={agent.kind} value={agent.kind}>
                {agent.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
          <SelectTrigger>
            <SelectValue placeholder="排序方式" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated_at">更新时间</SelectItem>
            <SelectItem value="created_at">创建时间</SelectItem>
            <SelectItem value="title">按字母顺序</SelectItem>
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder="项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部项目</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl bg-muted/40">
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3 text-sm text-foreground/70">
          <span>{filteredSessions.length} 个对话</span>
          <span className="flex items-center gap-1.5">
            <FolderOpen className="h-4 w-4" />
            归档列表
          </span>
        </div>

        <div className="max-h-[52vh] overflow-auto">
          {filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-sm text-foreground/55">
              <Archive className="h-8 w-8 text-foreground/24" />
              没有匹配的已归档对话
            </div>
          ) : (
            filteredSessions.map((session) => {
              const displayTitle = resolvedTitles[session.id] ?? getSessionDisplayTitle(session.title);
              const agentDef = getAgentDefinition(session.agent_kind);
              const agentLabel = agentDef?.label ?? session.agent_kind;

              return (
                <div key={session.id} className="border-b border-border/55 px-4 py-3 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90"
                      title={displayTitle}
                    >
                      {displayTitle}
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(session)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => unarchiveSession(session.id)}>
                        <Undo2 className="h-4 w-4" />
                        取消归档
                      </Button>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/60">
                    <span className="inline-flex min-w-0 items-center gap-1">
                      {agentDef ? (
                        <>
                          <AgentBrandIcon agent={agentDef} size="sm" />
                          <span className="truncate">{agentLabel}</span>
                        </>
                      ) : (
                        <span className="truncate">{agentLabel}</span>
                      )}
                    </span>
                    <span>创建 {formatDateTime(session.created_at)}</span>
                    <span>更新 {formatDateTime(session.updated_at)}</span>
                    {session.project_id && (
                      <span className="inline-flex items-center gap-1">
                        <FolderOpen className="h-3 w-3" />
                        {projects.find((project) => project.id === session.project_id)?.name ?? session.project_id}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除归档对话"
        description={`确定要删除"${deleteTarget ? (resolvedTitles[deleteTarget.id] ?? getSessionDisplayTitle(deleteTarget.title)) : ''}"吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={() => deleteTarget ? handleDelete(deleteTarget) : undefined}
        overlayClassName="z-230"
      />

      <ConfirmDialog
        open={clearConfirm}
        onOpenChange={(open) => !isClearing && setClearConfirm(open)}
        title="全部删除"
        description={`确定要删除当前筛选结果中的 ${filteredSessions.length} 个已归档对话吗？此操作不可撤销。`}
        confirmLabel="全部删除"
        variant="destructive"
        onConfirm={handleClearAll}
        loading={isClearing}
        overlayClassName="z-230"
      />
    </div>
  );
}
