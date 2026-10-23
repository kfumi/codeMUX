import { useEffect, useMemo, useState } from 'react';
import { Folder, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { openDialog } from '../../lib/desktopDialogs';
import { useProjectStore } from '../../stores/projectStore';
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
import {
  appendPickedRoots,
  disambiguatedRootNames,
  projectRootName,
  removeRootKeepingPrimary,
  type EditableProjectRoot,
} from './projectRoots';

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 创建项目：先给项目起名、再挑一组源文件夹，而不是点加号就直接落库。
 * 第一个文件夹是主根（新会话的工作目录），其余文件夹对该会话可读写。
 */
export function ProjectCreateDialog({ open, onOpenChange }: ProjectCreateDialogProps) {
  const createProject = useProjectStore((state) => state.createProject);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [roots, setRoots] = useState<EditableProjectRoot[]>([]);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName('');
    setNameTouched(false);
    setRoots([]);
    setPicking(false);
    setCreating(false);
  }, [open]);

  const names = useMemo(() => disambiguatedRootNames(roots), [roots]);

  const syncDefaultName = (nextRoots: EditableProjectRoot[]) => {
    if (nameTouched) {
      return;
    }
    setName(nextRoots.length > 0 ? projectRootName(nextRoots[0].path) : '');
  };

  const handleAddFolders = async () => {
    if (picking) {
      return;
    }
    setPicking(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: '选择源文件夹（可多选）',
      });
      if (!selected || selected.length === 0) {
        return;
      }
      // 原生选择器的返回顺序即根顺序：第一个成为主根。
      const picked = Array.isArray(selected) ? selected : [selected];
      const next = appendPickedRoots(roots, picked);
      setRoots(next);
      syncDefaultName(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const handleRemoveRoot = (path: string) => {
    const next = removeRootKeepingPrimary(roots, path);
    setRoots(next);
    syncDefaultName(next);
  };

  // 切换主根只改标记，不重排用户刚选好的顺序；创建接口通过 primaryRoot 接收它。
  const handleSetPrimary = (path: string) => {
    setRoots((current) => current.map((root) => ({
      ...root,
      isPrimary: root.path === path,
    })));
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('项目名称不能为空');
      return;
    }
    if (roots.length === 0) {
      toast.error('请至少选择一个源文件夹');
      return;
    }
    const primary = roots.find((root) => root.isPrimary) ?? roots[0];
    setCreating(true);
    try {
      await createProject(
        trimmedName,
        roots.map((root) => root.path),
        primary.path,
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85dvh,38rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-120">
        <DialogHeader className="px-6 pb-3 pt-6">
          <DialogTitle className="text-base leading-tight">创建项目</DialogTitle>
          <DialogDescription className="text-ui-compact leading-relaxed text-muted-foreground">
            第一个文件夹默认是主根，可点「设为主要」调整；新会话在它下面运行，其余文件夹同样可读写。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-compact font-medium text-foreground">项目名称</span>
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameTouched(true);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && !creating) {
                  void handleCreate();
                }
              }}
              placeholder="新项目"
              className="h-8 text-ui-compact"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-compact font-medium text-foreground">源文件夹</span>
            {roots.length === 0 ? (
              <button
                type="button"
                onClick={() => void handleAddFolders()}
                disabled={picking}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-foreground/4 px-4 py-8 text-center transition-colors duration-fast hover:border-border hover:bg-foreground/8"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  <Folder className="h-4 w-4" />
                </span>
                <span className="text-ui-compact font-medium text-foreground">
                  {picking ? '正在选择…' : '选择文件夹'}
                </span>
                <span className="text-ui-micro text-muted-foreground">
                  CodeMUX 可读取和编辑这些文件夹
                </span>
              </button>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/60">
                {roots.map((root, index) => (
                  <div
                    key={root.path}
                    className="flex items-center gap-2 border-b border-border/40 px-3 py-2"
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
                      aria-label={`移除 ${projectRootName(root.path)}`}
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveRoot(root.path)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                  onClick={() => void handleAddFolders()}
                  disabled={picking}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  添加文件夹
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-border/40 bg-[hsl(var(--surface-2))] px-6 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={creating}
            className="h-8 px-3.5 text-ui-compact"
          >
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || picking || !name.trim() || roots.length === 0}
            className="h-8 gap-1.5 px-3.5 text-ui-compact"
          >
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            创建项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
