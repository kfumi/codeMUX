import { useState, useEffect } from 'react';
import { useSkillStore } from '../../stores/skillStore';
import type { Skill } from '../../types/skill';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Trash2, Loader2, Eye, Puzzle } from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownRenderer } from '../agent/MarkdownRenderer';

export function SkillsSettingsPanel() {
  const {
    installedSkills, isLoading,
    fetchInstalled, uninstallSkill,
    toggleSkill, getSkillContent, syncBuiltins,
  } = useSkillStore();

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');

  useEffect(() => {
    syncBuiltins().then(() => fetchInstalled());
  }, []);

  const handleUninstall = async () => {
    if (!deletingId) return;
    try {
      await uninstallSkill(deletingId);
      toast.success('已卸载');
    } catch {
      toast.error('卸载失败');
    }
    setDeleteConfirm(false);
    setDeletingId(null);
  };

  const handlePreview = async (skill: Skill) => {
    const content = await getSkillContent(skill.id);
    setPreviewContent(content);
    setPreviewTitle(skill.display_name || skill.name);
  };

  return (
    <div className="space-y-4 pr-12">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <Puzzle className="h-4 w-4" />
          Skills ({installedSkills.length})
        </h3>
      </div>

      <p className="text-xs text-muted-foreground">
        内置 skills 始终启用。通过对话中使用 <code className="text-xs bg-muted px-1 rounded">/find-skills</code> 搜索和安装新 skills。
      </p>

      {isLoading && installedSkills.length === 0 && (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          加载中...
        </div>
      )}

      <div className="space-y-2">
        {installedSkills.map((skill) => (
          <div
            key={skill.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/65 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">
                  {skill.display_name || skill.name}
                </span>
                {skill.is_builtin && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    内置
                  </span>
                )}
              </div>
              {skill.description && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {skill.description}
                </p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => handlePreview(skill)}>
              <Eye className="h-4 w-4" />
            </Button>
            {!skill.is_builtin && (
              <>
                <div
                  className={`h-5 w-9 rounded-full relative cursor-pointer shrink-0 transition-colors ${skill.enabled ? 'bg-primary' : 'bg-muted-foreground/25'}`}
                  onClick={() => toggleSkill(skill.id, !skill.enabled)}
                >
                  <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${skill.enabled ? 'left-4.5' : 'left-0.5'}`} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDeletingId(skill.id); setDeleteConfirm(true); }}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <DialogContent className="border-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-100">
          <DialogHeader>
            <DialogTitle>卸载 Skill</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要卸载 "{installedSkills.find((s) => s.id === deletingId)?.name}" 吗？文件将从磁盘删除。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>取消</Button>
            <Button variant="destructive" onClick={handleUninstall}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Content preview */}
      <Dialog open={!!previewContent} onOpenChange={(open) => !open && setPreviewContent(null)}>
        <DialogContent className="max-h-[70vh] overflow-y-auto border-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-150">
          <DialogHeader>
            <DialogTitle>{previewTitle}</DialogTitle>
          </DialogHeader>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={previewContent || ''} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
