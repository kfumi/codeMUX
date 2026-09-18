import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { LogFileInfo } from '../../lib/desktop-bridge';
import { shellFacade } from '../../lib/facades/shell-facade';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

/** 过滤出日志视图可展示的 .log 文件,按修改时间倒序(壳侧 listLogFiles 已倒序,这里兜底重排)。 */
export function pickLogFiles(files: LogFileInfo[]): LogFileInfo[] {
  return files
    .filter((f) => f.name.endsWith('.log'))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** 默认展示 daemon 运行日志;缺失时回退到最新修改的日志文件。 */
export function pickDefaultLogFile(files: LogFileInfo[]): string {
  if (files.length === 0) return '';
  return files.some((f) => f.name === 'daemon.log') ? 'daemon.log' : files[0].name;
}

export function LogSettings() {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [logContent, setLogContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [logDir, setLogDir] = useState<string>('');
  const [lastRefresh, setLastRefresh] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const selectedFileRef = useRef('');

  const applyContent = useCallback((content: string) => {
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
  }, []);

  const readInto = useCallback(async (name: string) => {
    applyContent(await shellFacade.readLogFile(name));
  }, [applyContent]);

  const loadLatestLog = useCallback(async () => {
    try {
      const [allFiles, dir] = await Promise.all([shellFacade.getLogFiles(), shellFacade.getLogDirectory()]);
      setLogDir(dir);

      // 工单 09 后日志为 daemon.log / renderer.log 等 .log 文件(旧 Tauri 的 codemux.log 已不存在)
      const logs = pickLogFiles(allFiles);
      setFiles(logs);
      if (logs.length === 0) {
        selectedFileRef.current = '';
        setSelectedFile('');
        setLogContent('');
        setError(null);
        return;
      }

      // 保持用户当前选择;失效或未选时回退到默认文件
      const current = selectedFileRef.current;
      const name = logs.some((f) => f.name === current) ? current : pickDefaultLogFile(logs);
      selectedFileRef.current = name;
      setSelectedFile(name);

      await readInto(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取日志失败');
    }
  }, [readInto]);

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

  const handleFileChange = (name: string) => {
    selectedFileRef.current = name;
    setSelectedFile(name);
    readInto(name).catch((e) => {
      setError(e instanceof Error ? e.message : '读取日志失败');
    });
  };

  const handleRefresh = () => {
    setLoading(true);
    loadLatestLog().finally(() => setLoading(false));
  };

  const handleOpenLogDir = () => {
    if (!logDir) return;
    shellFacade.openInExplorer(logDir).catch(() => {});
  };

  const getLineClass = (line: string) => {
    if (line.includes('ERROR')) return 'text-destructive';
    if (line.includes('WARN')) return 'text-yellow-600 dark:text-yellow-400';
    if (line.includes('INFO')) return 'text-foreground';
    if (line.includes('DEBUG') || line.includes('TRACE')) return 'text-muted-foreground';
    return 'text-foreground';
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end gap-2">
        {files.length > 1 && (
          <Select value={selectedFile} onValueChange={handleFileChange}>
            <SelectTrigger aria-label="日志文件" className="h-8 w-52 text-ui-compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {files.map((f) => (
                <SelectItem key={f.name} value={f.name} className="text-ui-compact">
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {lastRefresh && (
          <span className="text-xs text-muted-foreground">更新于 {lastRefresh}</span>
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

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl settings-tile">
        <div
          ref={contentRef}
          className="h-[60vh] overflow-auto p-4 font-mono text-code leading-relaxed"
        >
          {logContent ? (
            logContent.split('\n').map((line, i) => (
              <div key={i} className={`${getLineClass(line)} whitespace-pre-wrap break-all`}>
                {line || ' '}
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <FileText className="h-8 w-8 text-muted-foreground" />
              暂无日志
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
