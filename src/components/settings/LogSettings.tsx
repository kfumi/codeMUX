import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import { appApi } from '../../lib/tauri';
import { Button } from '../ui/button';

export function LogSettings() {
  const [logContent, setLogContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [logDir, setLogDir] = useState<string>('');
  const [lastRefresh, setLastRefresh] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const loadLatestLog = useCallback(async () => {
    try {
      const [files, dir] = await Promise.all([appApi.getLogFiles(), appApi.getLogDirectory()]);
      setLogDir(dir);

      // Find the latest codemux log file (match .log extension to avoid picking up crash dumps, etc.)
      const codemuxLog = files.find((f) => f.name.startsWith('codemux') && f.name.endsWith('.log'));
      if (!codemuxLog) {
        setLogContent('');
        setError(null);
        return;
      }

      const content = await appApi.readLogFile(codemuxLog.name);

      // Check if user is near the bottom before updating
      const el = contentRef.current;
      if (el) {
        wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }

      setLogContent(content);
      setError(null);
      setLastRefresh(new Date().toLocaleTimeString('zh-CN'));

      // Auto-scroll to bottom if user was at the bottom
      requestAnimationFrame(() => {
        if (contentRef.current && wasAtBottomRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取日志失败');
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    loadLatestLog().finally(() => setLoading(false));
  }, [loadLatestLog]);

  // Auto-refresh every 3 seconds
  useEffect(() => {
    const timer = setInterval(loadLatestLog, 3000);
    return () => clearInterval(timer);
  }, [loadLatestLog]);

  const handleRefresh = () => {
    setLoading(true);
    loadLatestLog().finally(() => setLoading(false));
  };

  const handleOpenLogDir = () => {
    if (!logDir) return;
    invoke('open_in_explorer', { path: logDir }).catch(() => {});
  };

  const getLineClass = (line: string) => {
    if (line.includes('ERROR')) return 'text-destructive';
    if (line.includes('WARN')) return 'text-yellow-600 dark:text-yellow-400';
    if (line.includes('INFO')) return 'text-foreground/80';
    if (line.includes('DEBUG') || line.includes('TRACE')) return 'text-foreground/50';
    return 'text-foreground/70';
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground/90">系统日志</h3>
          <p className="text-xs text-foreground/60">实时查看应用运行日志（codemux.log），每 3 秒自动刷新。</p>
        </div>
        <div className="flex items-center gap-2 mr-10">
          {lastRefresh && (
            <span className="text-xs text-foreground/40">更新于 {lastRefresh}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleRefresh}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleOpenLogDir}
            disabled={!logDir}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开日志目录
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-card">
        <div
          ref={contentRef}
          className="h-[60vh] overflow-auto p-4 font-mono text-xs leading-relaxed"
        >
          {logContent ? (
            logContent.split('\n').map((line, i) => (
              <div key={i} className={`${getLineClass(line)} whitespace-pre-wrap break-all`}>
                {line || ' '}
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-foreground/55">
              <FileText className="h-8 w-8 text-foreground/24" />
              暂无日志
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
