import { useState, useEffect, useMemo } from 'react';
import { useSkillStore } from '../../stores/skillStore';
import type { ImportableSkill, Skill, SkillApps } from '../../types/skill';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { TooltipHint } from '../ui/tooltip';
import { Trash2, Loader2, Eye, RefreshCw, Download, Check } from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownRenderer } from '../agent/MarkdownRenderer';
import { cn } from '../../lib/utils';

// Agent brand SVGs for per-tool toggle icons
import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';

const APP_SVGS: Record<keyof SkillApps, string> = {
  claude: claudeSvg,
  codex: openAiSvg,
  gemini: geminiSvg,
  opencode: opencodeSvg,
};

const APP_LABELS: Record<keyof SkillApps, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

const APP_ORDER: Array<keyof SkillApps> = ['claude', 'codex', 'gemini', 'opencode'];

function AppIcon({ app, size = 16 }: { app: keyof SkillApps; size?: number }) {
  const svg = APP_SVGS[app];
  const cleaned = svg
    .replace(/(<svg\b[^>]*\bstyle=")[^"]*(")/, '$1display:block$2')
    .replace(/(<svg\b[^>]*) width="[^"]*"/, '$1')
    .replace(/(<svg\b[^>]*) height="[^"]*"/, '$1')
    .replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: cleaned }}
    />
  );
}

export function SkillsSettingsPanel() {
  const {
    installedSkills, isLoading,
    fetchInstalled, uninstallSkill,
    toggleApp, getSkillContent, syncBuiltins,
    importFromApps, listImportable,
  } = useSkillStore();

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importable, setImportable] = useState<ImportableSkill[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [loadingImportable, setLoadingImportable] = useState(false);

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

  const handleOpenImport = async () => {
    setLoadingImportable(true);
    setImportDialogOpen(true);
    try {
      const list = await listImportable();
      setImportable(list);
      setSelectedNames(new Set(list.map((s) => s.name)));
    } catch {
      toast.error('扫描可导入 skills 失败');
    } finally {
      setLoadingImportable(false);
    }
  };

  const handleToggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleConfirmImport = async () => {
    setImporting(true);
    try {
      const names = Array.from(selectedNames);
      const total = await importFromApps(names);
      if (total > 0) {
        toast.success(`已导入 ${total} 个 skill`);
      } else {
        toast.info('没有新的 skill 被导入');
      }
      setImportDialogOpen(false);
    } catch {
      toast.error('导入失败');
    } finally {
      setImporting(false);
    }
  };

  // Group importable skills by source app
  const groupedImportable = useMemo(() => {
    const groups: Partial<Record<keyof SkillApps, ImportableSkill[]>> = {};
    for (const skill of importable) {
      const app = skill.source_app as keyof SkillApps;
      if (!groups[app]) groups[app] = [];
      groups[app]!.push(skill);
    }
    return APP_ORDER.filter((app) => groups[app]?.length).map((app) => ({
      app,
      skills: groups[app]!,
    }));
  }, [importable]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={handleOpenImport}>
          <Download className="h-4 w-4 mr-1" />
          从工具导入
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { syncBuiltins().then(() => fetchInstalled()); }}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

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
              </div>
              {skill.description && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {skill.description}
                </p>
              )}
              {skill.disk_path && (
                <TooltipHint content={skill.disk_path}>
                  <p
                    className="text-[10px] text-muted-foreground/60 truncate mt-0.5 font-mono"
                  >
                    {skill.disk_path}
                  </p>
                </TooltipHint>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => handlePreview(skill)}>
              <Eye className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1">
              {APP_ORDER.map((app) => (
                <TooltipHint content={APP_LABELS[app]}>
                  <button
                    key={app}
                    aria-label={`toggle-${skill.id}-${app}`}
                    onClick={() => toggleApp(skill.id, app, !skill.apps[app])}
                    className={cn(
                      'inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors',
                      skill.apps[app]
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-background border-transparent opacity-40 hover:opacity-70',
                    )}
                  >
                    <AppIcon app={app} size={16} />
                  </button>
                </TooltipHint>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setDeletingId(skill.id); setDeleteConfirm(true); }}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <DialogContent overlayClassName="z-230" className="border-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-100">
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

      {/* Import dialog */}
      <Dialog open={importDialogOpen} onOpenChange={(open) => !open && setImportDialogOpen(false)}>
        <DialogContent overlayClassName="z-230" className="border-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-130 max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>从工具导入 Skills</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0">
            {loadingImportable ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                扫描中...
              </div>
            ) : groupedImportable.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                没有发现可导入的 skill
              </div>
            ) : (
              <div className="space-y-4">
                {groupedImportable.map(({ app, skills }) => (
                  <div key={app} className="space-y-1.5">
                    <div className="flex items-center gap-2 px-1">
                      <AppIcon app={app} size={14} />
                      <span className="text-xs font-medium text-muted-foreground">
                        {APP_LABELS[app]}
                      </span>
                      <span className="text-xs text-muted-foreground/60">
                        ({skills.length})
                      </span>
                    </div>
                    {skills.map((skill) => {
                      const checked = selectedNames.has(skill.name);
                      return (
                        <label
                          key={skill.name}
                          className={cn(
                            'flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                            checked
                              ? 'bg-primary/5 border-primary/30'
                              : 'bg-card border-border hover:bg-muted/50',
                          )}
                        >
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            aria-label={`select-${skill.name}`}
                            onClick={() => handleToggleSelect(skill.name)}
                            className={cn(
                              'inline-flex items-center justify-center w-5 h-5 rounded border-2 transition-colors shrink-0',
                              checked
                                ? 'bg-primary border-primary text-primary-foreground'
                                : 'bg-background border-muted-foreground/40',
                            )}
                          >
                            {checked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {skill.display_name || skill.name}
                            </div>
                            {skill.description && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {skill.description}
                              </p>
                            )}
                            {skill.disk_path && (
                              <TooltipHint content={skill.disk_path}>
                                <p
                                  className="text-[10px] text-muted-foreground/60 truncate mt-0.5 font-mono"
                                >
                                  {skill.disk_path}
                                </p>
                              </TooltipHint>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>取消</Button>
            <Button
              onClick={handleConfirmImport}
              disabled={importing || selectedNames.size === 0}
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              导入{selectedNames.size > 0 ? ` (${selectedNames.size})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Content preview */}
      <Dialog open={!!previewContent} onOpenChange={(open) => !open && setPreviewContent(null)}>
        <DialogContent overlayClassName="z-230" className="max-h-[85vh] overflow-y-auto border-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-[80vw]">
          <DialogHeader>
            <DialogTitle>{previewTitle}</DialogTitle>
          </DialogHeader>
          <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto">
            <MarkdownRenderer content={previewContent || ''} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
