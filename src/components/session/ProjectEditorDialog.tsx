import { useEffect, useMemo, useState } from 'react';
import { Folder, Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { openDialog } from '../../lib/desktopDialogs';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Project } from '../../types/project';
import { getPrimaryProjectRoot } from '../../types/project';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { TooltipHint } from '../ui/tooltip';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface ProjectEditorDialogProps {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EditableRoot {
  path: string;
  isPrimary: boolean;
}

function normalizeRootPath(path: string): string {
  const stripped = path.trim().replace(/[/\\]+$/, '');
  return stripped.toLowerCase();
}

function rootName(path: string): string {
  return path.split(/[/\\]+/).filter(Boolean).at(-1) ?? path;
}

/** 同一项目里出现同名文件夹时，用上一级目录名消歧。 */
function disambiguatedNames(roots: EditableRoot[]): string[] {
  const names = roots.map((root) => rootName(root.path));
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return roots.map((root, index) => {
    const name = names[index];
    if ((counts.get(name) ?? 0) < 2) {
      return name;
    }
    const segments = root.path.split(/[/\\]+/).filter(Boolean);
    const parent = segments.at(-2);
    return parent ? `${parent}/${name}` : name;
  });
}

function pathKey(path: string | null | undefined): string {
  return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = pathKey(root);
  const normalizedCandidate = pathKey(candidate);
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function projectSessionCount(projectId: string): number {
  const state = useSessionStore.getState();
  return [...state.sessions, ...state.archivedSessions]
    .filter((session) => session.project_id === projectId)
    .length;
}

/**
 * 移除一个根会影响多少条会话：工作目录落在该根下的会话。
 * 会话工作目录缺失（老数据）时按项目主根估算。
 */
function sessionsUnderRoot(project: Project, root: string): number {
  const state = useSessionStore.getState();
  const fallback = getPrimaryProjectRoot(project);
  return [...state.sessions, ...state.archivedSessions].filter((session) => {
    if (session.project_id !== project.id) {
      return false;
    }
    return isPathInside(root, session.working_path ?? fallback ?? '');
  }).length;
}

export function ProjectEditorDialog({ project, open, onOpenChange }: ProjectEditorDialogProps) {
  const updateProject = useProjectStore((state) => state.updateProject);
  const deleteProject = useProjectStore((state) => state.deleteProject);
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<EditableRoot[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) {
      return;
    }
    setName(project.name);
    setRoots(
      [...project.roots]
        .sort((left, right) => left.position - right.position)
        .map((root, index, list) => ({
          path: root.path,
          // 主根缺失时顺序最小者兜底，与 daemon 的继承规则一致。
          isPrimary: root.isPrimary || (index === 0 && !list.some((entry) => entry.isPrimary)),
        })),
    );
    setNotice(null);
  }, [open, project]);

  const names = useMemo(() => disambiguatedNames(roots), [roots]);

  if (!project) {
    return null;
  }

  const handleSetPrimary = (path: string) => {
    setRoots((current) => current.map((root) => ({ ...root, isPrimary: root.path === path })));
  };

  const handleRemoveRoot = (path: string) => {
    if (roots.length <= 1) {
      // 最后一个根不能空着保存：切到删除项目流程。
      setDeleteOpen(true);
      return;
    }
    const remaining = roots.filter((root) => root.path !== path);
    if (!remaining.some((root) => root.isPrimary)) {
      // 移除主根后，顺序最小的剩余根自动继任。
      remaining[0] = { ...remaining[0], isPrimary: true };
    }
    setRoots(remaining);
    const affected = sessionsUnderRoot(project, path);
    setNotice(
      affected > 0
        ? `已移除「${rootName(path)}」。${affected} 条会话的工作目录不变，仍会在原目录继续运行。`
        : `已移除「${rootName(path)}」。已有会话的工作目录不会改变。`,
    );
  };

  const handleAddFolders = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: '添加源文件夹（可多选）',
      });
      if (!selected || selected.length === 0) {
        return;
      }
      const picked = Array.isArray(selected) ? selected : [selected];
      setRoots((current) => {
        const existing = new Set(current.map((root) => normalizeRootPath(root.path)));
        const appended = [...current];
        for (const path of picked) {
          if (existing.has(normalizeRootPath(path))) {
            continue;
          }
          existing.add(normalizeRootPath(path));
          appended.push({ path, isPrimary: false });
        }
        return appended;
      });
      setNotice(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('项目名称不能为空');
      return;
    }
    if (roots.length === 0) {
      setDeleteOpen(true);
      return;
    }
    const primary = roots.find((root) => root.isPrimary) ?? roots[0];
    setSaving(true);
    try {
      await updateProject(project.id, {
        name: trimmedName,
        roots: roots.map((root) => root.path),
        primaryRoot: primary.path,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      setDeleteOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const totalSessions = projectSessionCount(project.id);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[min(85dvh,34rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-120">
          <DialogHeader className="px-6 pb-3 pt-6">
            <DialogTitle className="text-base leading-tight">编辑项目</DialogTitle>
            <DialogDescription className="text-ui-compact leading-relaxed text-muted-foreground">
              项目由一组源文件夹组成；新建会话落在主根，其余文件夹对该会话可读写。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-ui-compact font-medium text-foreground">项目名称</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="项目名称"
                className="h-8 text-ui-compact"
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-ui-compact font-medium text-foreground">源文件夹</span>
              <div className="overflow-hidden rounded-md border border-border/60">
                {roots.map((root, index) => (
                  <div
                    key={root.path}
                    className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <TooltipHint content={root.path}>
                      <span className="min-w-0 flex-1 truncate text-ui-compact text-foreground">
                        {names[index]}
                      </span>
                    </TooltipHint>
                    {root.isPrimary ? (
                      <span className="shrink-0 rounded-xs bg-secondary px-1.5 py-0.5 text-ui-micro text-muted-foreground">
                        主要
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="shrink-0"
                        onClick={() => handleSetPrimary(root.path)}
                      >
                        设为主要
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`移除 ${rootName(root.path)}`}
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveRoot(root.path)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => void handleAddFolders()}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui-compact text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  添加文件夹
                </button>
              </div>
              {notice ? (
                <p className="text-ui-micro leading-snug text-muted-foreground">{notice}</p>
              ) : null}
            </div>
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t border-border/40 bg-muted/30 px-6 py-4">
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto h-8 gap-1.5 px-3 text-ui-compact text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除项目
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="h-8 px-3.5 text-ui-compact"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving}
              className="h-8 gap-1.5 px-3.5 text-ui-compact"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除项目"
        description={
          roots.length <= 1
            ? `项目至少需要一个源文件夹。删除“${project.name}”会同时删除其名下 ${totalSessions} 条会话，且不可恢复。`
            : `删除“${project.name}”会同时删除其名下 ${totalSessions} 条会话（包括工作目录已不在源文件夹内的会话），且不可恢复。`
        }
        confirmLabel="删除"
        variant="destructive"
        loading={deleting}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}
