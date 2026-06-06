import { useState, useEffect } from 'react';
import { useSkillStore } from '../../stores/skillStore';
import type { Skill, RepoSkillEntry } from '../../types/skill';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import {
  Trash2, Loader2, Package, Search, Download,
  CheckCircle, ExternalLink, Eye, Puzzle,
} from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownRenderer } from '../agent/MarkdownRenderer';

export function SkillsSettingsPanel() {
  const {
    installedSkills, browseResults, skillSources,
    isLoading, browseLoading,
    fetchInstalled, browseRepo, installSkill, uninstallSkill,
    toggleSkill, getSkillContent, syncBuiltins, fetchSources,
  } = useSkillStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    syncBuiltins().then(() => {
      fetchInstalled();
      fetchSources().then(() => {
        const defaultSource = skillSources[0];
        if (defaultSource) {
          browseRepo(defaultSource.repo, defaultSource.branch, defaultSource.skills_path);
        }
      });
    });
  }, []);

  useEffect(() => {
    if (skillSources.length > 0 && browseResults.length === 0 && !browseLoading) {
      const s = skillSources[0];
      browseRepo(s.repo, s.branch, s.skills_path);
    }
  }, [skillSources]);

  const handleInstall = async (entry: RepoSkillEntry) => {
    const source = skillSources[0];
    if (!source) return;
    setInstalling(entry.name);
    try {
      await installSkill(source.repo, source.branch, entry.path, entry.name);
      toast.success(`已安装 ${entry.name}`);
    } catch {
      toast.error(`安装 ${entry.name} 失败`);
    } finally {
      setInstalling(null);
    }
  };

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

  const filteredBrowse = browseResults.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.description?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="space-y-6 pr-12">
      {/* Marketplace */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium flex items-center gap-2">
            <Package className="h-4 w-4" />
            Skills 市场
          </h3>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {skillSources.length > 0 && (
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                {skillSources[0].repo}
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索 skills..."
            className="pl-9"
          />
        </div>

        {browseLoading && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            加载中...
          </div>
        )}

        {!browseLoading && filteredBrowse.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Package className="h-6 w-6 mb-2 opacity-50" />
            <p className="text-sm">暂无可用 skills</p>
          </div>
        )}

        <div className="space-y-2 max-h-[240px] overflow-y-auto">
          {filteredBrowse.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">{entry.name}</span>
                {entry.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {entry.description}
                  </p>
                )}
              </div>
              {entry.installed ? (
                <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" />
                  已安装
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleInstall(entry)}
                  disabled={installing === entry.name}
                >
                  {installing === entry.name ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3 mr-1" />
                  )}
                  安装
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Installed Skills */}
      <div className="space-y-3">
        <h3 className="font-medium flex items-center gap-2">
          <Puzzle className="h-4 w-4" />
          已安装 Skills ({installedSkills.length})
        </h3>

        {isLoading && installedSkills.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            加载中...
          </div>
        )}

        {!isLoading && installedSkills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Puzzle className="h-6 w-6 mb-2 opacity-50" />
            <p className="text-sm">暂无已安装的 skills</p>
          </div>
        )}

        <div className="space-y-2">
          {installedSkills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
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
              <Switch
                checked={skill.enabled}
                onCheckedChange={(enabled) => toggleSkill(skill.id, enabled)}
              />
              {!skill.is_builtin && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDeletingId(skill.id); setDeleteConfirm(true); }}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <DialogContent className="sm:max-w-[400px]">
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
        <DialogContent className="sm:max-w-[600px] max-h-[70vh] overflow-y-auto">
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
