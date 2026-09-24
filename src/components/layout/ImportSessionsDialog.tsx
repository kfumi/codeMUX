import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';

import { isImportCandidateForProject } from '../../lib/importSessionPaths';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import type { ImportSessionsResult } from '../../types/historyImport';
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
  projectId: string;
  projectPath: string;
  projectName: string;
  onImported?: () => void;
}

const agentLabels: Record<AgentKind, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  gemini_cli: 'Gemini CLI',
  opencode: 'OpenCode',
  pi: 'pi',
};

type ImportFilter = 'all' | AgentKind;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ImportSessionsDialog({
  open,
  onOpenChange,
  projectId,
  projectPath,
  projectName,
  onImported,
}: ImportSessionsDialogProps) {
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const fetchArchivedSessions = useSessionStore((state) => state.fetchArchivedSessions);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<ImportFilter>('claude_code');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const scanGenerationRef = useRef(0);
  const importGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    scanGenerationRef.current += 1;
    importGenerationRef.current += 1;

    if (!open) {
      setLoading(false);
      setImporting(false);
      return () => {
        scanGenerationRef.current += 1;
        importGenerationRef.current += 1;
      };
    }

    setCandidates([]);
    setSelected(new Set());
    setFilter('claude_code');
    setLoading(false);
    setImporting(false);
    setHasScanned(false);
    setError(null);

    return () => {
      scanGenerationRef.current += 1;
      importGenerationRef.current += 1;
    };
  }, [open, projectId]);

  useEffect(() => {
    return () => {
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = '';
      }
    };
  }, []);

  const handleFilterChange = (value: string) => {
    scanGenerationRef.current += 1;
    setFilter(value as ImportFilter);
    setCandidates([]);
    setSelected(new Set());
    setHasScanned(false);
    setError(null);
    setLoading(false);
  };

  const handleDiscover = async () => {
    scanGenerationRef.current += 1;
    const generation = scanGenerationRef.current;
    setLoading(true);
    setHasScanned(false);
    setError(null);
    try {
      const items = await daemonFacade.historyImport.discover(filter === 'all' ? undefined : filter);
      if (generation !== scanGenerationRef.current) return;
      setCandidates(items);
      setSelected(new Set());
      setHasScanned(true);
    } catch (reason) {
      if (generation !== scanGenerationRef.current) return;
      setError(String(reason));
    } finally {
      if (generation === scanGenerationRef.current) {
        setLoading(false);
      }
    }
  };

  const projectCandidates = useMemo(
    () => candidates.filter((candidate) => isImportCandidateForProject(candidate.cwd, projectPath)),
    [candidates, projectPath],
  );

  const visibleCandidates = useMemo(
    () => filter === 'all'
      ? projectCandidates
      : projectCandidates.filter((candidate) => candidate.agentKind === filter),
    [filter, projectCandidates],
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
    const generation = importGenerationRef.current + 1;
    importGenerationRef.current = generation;
    setImporting(true);
    setError(null);
    try {
      const result = await daemonFacade.historyImport.import({
        candidateKeys: [...selected],
        projectId,
        refreshExisting: true,
        agentKind: filter === 'all' ? undefined : filter,
      }) as ImportSessionsResult;
      if (generation !== importGenerationRef.current) return;
      await Promise.all([fetchSessions(), fetchArchivedSessions()]);
      if (generation !== importGenerationRef.current) return;
      const count = result.importedCount + result.refreshedCount;
      const skippedMessages = result.skippedKeys.map((key) => `${key}: 候选已失效，请重新扫描`);
      if (result.errors.length > 0 || skippedMessages.length > 0) {
        setError([...result.errors, ...skippedMessages].join('\n'));
        toast.warning(`已处理 ${count} 个会话，${result.errors.length + result.skippedKeys.length} 个失败`);
        onImported?.();
      } else {
        toast.success(`已导入 ${count} 个会话`);
        onImported?.();
        onOpenChange(false);
      }
    } catch (reason) {
      if (generation !== importGenerationRef.current) return;
      setError(String(reason));
    } finally {
      if (generation === importGenerationRef.current) {
        setImporting(false);
      }
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
      <DialogContent
        overlayClassName="z-[240]"
        className="z-[240] max-w-3xl gap-0 overflow-hidden rounded-xl border border-[hsl(var(--surface-edge))]/90 p-0 shadow-[0_18px_46px_-30px_hsl(var(--surface-shadow-strong)/0.82)]"
        closeClassName="right-5 top-5"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="border-b border-border/60 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4 text-primary" />
            导入外部会话
          </DialogTitle>
          <DialogDescription>
            扫描与项目「{projectName}」工作目录匹配的 CLI 历史会话，导入后将归属该项目。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-b border-border/45 bg-muted/18 px-6 py-3">
          <label className="min-w-0 space-y-1.5">
            <span className="block text-ui-caption font-medium text-muted-foreground">历史来源</span>
            <Select value={filter} onValueChange={handleFilterChange} disabled={loading || importing}>
              <SelectTrigger aria-label="筛选智能体" className="h-9 rounded-lg px-2.5 text-xs">
                <SelectValue placeholder="选择来源" />
              </SelectTrigger>
              <SelectContent align="start" className="z-260">
                <SelectItem value="claude_code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="pi">pi</SelectItem>
                <SelectItem value="all">全部来源（较慢）</SelectItem>
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
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                仅显示工作目录位于「{projectName}」下的会话，不会修改原始历史文件。
              </p>
            </div>
          )}

          {!loading && !error && hasScanned && visibleCandidates.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <p>该项目下没有发现可导入的会话历史</p>
              <p className="mt-1 text-xs">可切换来源后重新扫描，或确认 CLI 会话的工作目录是否在此项目内。</p>
            </div>
          )}

          {!loading && !error && hasScanned && visibleCandidates.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1 text-ui-caption text-muted-foreground">
                <span>发现 {visibleCandidates.length} 个会话</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-ui-caption" onClick={toggleAllVisible}>
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
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-ui-micro font-medium text-muted-foreground">{agentLabels[candidate.agentKind]}</span>
                        {candidate.alreadyImported && <span className="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-ui-micro text-emerald-700 dark:text-emerald-300">已导入</span>}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{candidate.cwd || candidate.sourceLocator}</span>
                      {candidate.warnings.length > 0 && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{candidate.warnings.join('；')}</span>}
                    </span>
                    <span className="whitespace-nowrap text-right text-ui-caption text-muted-foreground">
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
