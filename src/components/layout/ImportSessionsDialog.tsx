import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, FolderOpen, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';

import { historyImportApi } from '../../lib/tauri';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { AgentKind } from '../../types/session';
import type { ImportCandidate } from '../../types/historyImport';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

interface ImportSessionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

const agentLabels: Record<AgentKind, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  gemini_cli: 'Gemini CLI',
  opencode: 'OpenCode',
};

type ImportFilter = 'all' | AgentKind;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ImportSessionsDialog({ open, onOpenChange, onImported }: ImportSessionsDialogProps) {
  const projects = useProjectStore((state) => state.projects);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const fetchArchivedSessions = useSessionStore((state) => state.fetchArchivedSessions);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<ImportFilter>('claude_code');
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCandidates([]);
    setSelected(new Set());
    setFilter('claude_code');
    setHasScanned(false);
    setError(null);
  }, [open]);

  const handleFilterChange = (value: string) => {
    setFilter(value as ImportFilter);
    setCandidates([]);
    setSelected(new Set());
    setHasScanned(false);
    setError(null);
  };

  const handleDiscover = async () => {
    setLoading(true);
    setHasScanned(false);
    setError(null);
    try {
      const items = await historyImportApi.discover(filter === 'all' ? undefined : filter);
      setCandidates(items);
      setSelected(new Set());
      setHasScanned(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  const visibleCandidates = useMemo(
    () => filter === 'all' ? candidates : candidates.filter((candidate) => candidate.agentKind === filter),
    [candidates, filter],
  );

  const toggleSelected = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      const result = await historyImportApi.import({
        candidateKeys: [...selected],
        projectId: projectId || null,
        refreshExisting: true,
        agentKind: filter === 'all' ? undefined : filter,
      });
      await Promise.all([fetchSessions(), fetchArchivedSessions()]);
      const count = result.importedCount + result.refreshedCount;
      if (result.errors.length > 0) {
        toast.warning(`已处理 ${count} 个会话，${result.errors.length} 个失败`);
      } else {
        toast.success(`已导入 ${count} 个会话`);
      }
      onImported();
      onOpenChange(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImporting(false);
    }
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = visibleCandidates.length > 0 && visibleCandidates.every((candidate) => next.has(candidate.key));
      for (const candidate of visibleCandidates) {
        if (allSelected) next.delete(candidate.key);
        else next.add(candidate.key);
      }
      return next;
    });
  };

  const scanLabel = filter === 'all' ? '扫描全部来源' : `扫描 ${agentLabels[filter]}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4 text-primary" />
            导入外部会话
          </DialogTitle>
          <DialogDescription>
            先选择一个 CLI 来源再扫描，避免打开窗口时一次性读取全部历史文件。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)_auto] items-end gap-3 border-b border-border/45 bg-muted/18 px-6 py-3">
          <label className="min-w-0 space-y-1.5">
            <span className="block text-[11px] font-medium text-muted-foreground">历史来源</span>
            <Select value={filter} onValueChange={handleFilterChange} disabled={loading || importing}>
              <SelectTrigger aria-label="筛选智能体" className="h-9 rounded-lg px-2.5 text-xs">
                <SelectValue placeholder="选择来源" />
              </SelectTrigger>
              <SelectContent align="start" className="z-260">
                <SelectItem value="claude_code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="all">全部来源（较慢）</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="min-w-0 space-y-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5" />
              归属项目
            </span>
            <Select value={projectId || 'none'} onValueChange={(value) => setProjectId(value === 'none' ? '' : value)} disabled={importing}>
              <SelectTrigger aria-label="导入项目" className="h-9 rounded-lg px-2.5 text-xs">
                <SelectValue placeholder="暂不绑定项目" />
              </SelectTrigger>
              <SelectContent align="start" className="z-260">
                <SelectItem value="none">暂不绑定项目</SelectItem>
                {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>

          <Button type="button" size="sm" onClick={() => void handleDiscover()} disabled={loading || importing}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? '扫描中…' : scanLabel}
          </Button>
        </div>

        <div className="max-h-[55vh] min-h-56 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="space-y-2" aria-label="正在扫描历史">
              {[0, 1, 2].map((item) => (
                <div key={item} className="grid animate-pulse grid-cols-[1rem_minmax(0,1fr)_5rem] gap-3 rounded-xl border border-border/45 px-3.5 py-3">
                  <span className="mt-0.5 h-4 w-4 rounded border border-border/60" />
                  <span className="space-y-2">
                    <span className="block h-3.5 w-2/3 rounded bg-muted" />
                    <span className="block h-3 w-1/2 rounded bg-muted/70" />
                  </span>
                  <span className="space-y-2">
                    <span className="ml-auto block h-3 w-12 rounded bg-muted" />
                    <span className="ml-auto block h-3 w-16 rounded bg-muted/70" />
                  </span>
                </div>
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleDiscover()}>重试</Button>
            </div>
          )}

          {!loading && !error && !hasScanned && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary/8 text-primary">
                <Search className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-foreground/85">准备扫描 {filter === 'all' ? '全部来源' : agentLabels[filter]}</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">扫描只读取默认历史目录，不会执行 CLI，也不会修改原始会话文件。</p>
            </div>
          )}

          {!loading && !error && hasScanned && visibleCandidates.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <p>没有发现可导入的会话历史</p>
              <p className="mt-1 text-xs">可以切换来源，或重新扫描当前来源。</p>
            </div>
          )}

          {!loading && !error && hasScanned && visibleCandidates.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                <span>发现 {visibleCandidates.length} 个会话</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={toggleAllVisible}>
                  <Check className="mr-1 h-3 w-3" />
                  全选当前
                </Button>
              </div>
              {visibleCandidates.map((candidate) => {
                const checked = selected.has(candidate.key);
                return (
                  <button
                    type="button"
                    key={candidate.key}
                    onClick={() => toggleSelected(candidate.key)}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${checked ? 'border-primary/45 bg-primary/7' : 'border-border/60 bg-background hover:bg-muted/35'}`}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded border ${checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/35'}`}>
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 truncate text-sm font-medium text-foreground/90">
                        <span className="truncate">{candidate.title}</span>
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{agentLabels[candidate.agentKind]}</span>
                        {candidate.alreadyImported && <span className="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">已导入</span>}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{candidate.cwd || candidate.sourceLocator}</span>
                      {candidate.warnings.length > 0 && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{candidate.warnings.join('；')}</span>}
                    </span>
                    <span className="whitespace-nowrap text-right text-[11px] text-muted-foreground">
                      <span className="block">{candidate.eventCount} 条事件</span>
                      <span className="mt-1 block">{formatDate(candidate.updatedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/60 bg-muted/12 px-6 py-3">
          <span className="mr-auto self-center text-xs text-muted-foreground">已选择 {selected.size} 个会话</span>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={() => void handleImport()} disabled={selected.size === 0 || importing || loading}>
            {importing ? '导入中…' : '导入选中会话'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
