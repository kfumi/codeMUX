import { useEffect, useMemo, useState } from 'react';
import { Archive, FolderOpen, Search, Trash2, Undo2 } from 'lucide-react';

import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
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
    if (sortMode === 'title') return a.title.localeCompare(b.title, 'zh-Hans-CN');
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
  const projects = useProjectStore((state) => state.projects);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);

  const [keyword, setKeyword] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('updated_at');
  const [projectId, setProjectId] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    fetchArchivedSessions();
    fetchProjects();
  }, [fetchArchivedSessions, fetchProjects]);

  const filteredSessions = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    const result = archivedSessions.filter((session) => {
      const matchesKeyword =
        !query ||
        session.title.toLowerCase().includes(query) ||
        session.id.toLowerCase().includes(query);
      const matchesProject = projectId === 'all' || session.project_id === projectId;
      return matchesKeyword && matchesProject;
    });
    return sortSessions(result, sortMode);
  }, [archivedSessions, keyword, projectId, sortMode]);

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

      <div className="grid gap-3 md:grid-cols-[1.3fr_0.8fr_0.8fr]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索已归档对话"
            className="pl-9"
          />
        </div>
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
            filteredSessions.map((session) => (
              <div key={session.id} className="flex items-center gap-3 border-b border-border/55 px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground/90">{session.title}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/60">
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
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除归档对话"
        description={`确定要删除"${deleteTarget?.title ?? ''}"吗？此操作不可撤销。`}
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
