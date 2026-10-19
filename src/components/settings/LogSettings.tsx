import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { LogFileContent, LogFileInfo } from '../../lib/desktop-bridge';
import { shellFacade } from '../../lib/facades/shell-facade';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

/** 轮询间隔(毫秒)。窗口隐藏时暂停,见下方 effect。 */
const POLL_INTERVAL_MS = 3000;

/** 单次最多渲染的行数(配合壳侧尾部读取,把 DOM 规模钳在常量级)。 */
const MAX_RENDER_LINES = 2000;

/** 按级别给行上色;纯函数,提到模块级避免每次渲染重建。 */
function getLineClass(line: string): string {
  if (line.includes('ERROR')) return 'text-destructive';
  if (line.includes('WARN')) return 'text-yellow-600 dark:text-yellow-400';
  if (line.includes('INFO')) return 'text-foreground';
  if (line.includes('DEBUG') || line.includes('TRACE')) return 'text-muted-foreground';
  return 'text-foreground';
}

/**
 * 行列表隔离成 memo 组件:父组件因「更新于」时间戳每 3s 重渲染时,
 * 只要 lines 引用不变就整体跳过,不再重建数千个 DOM 节点。
 */
const LogLines = memo(function LogLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={`${getLineClass(line)} whitespace-pre-wrap break-all`}>
          {line || ' '}
        </div>
      ))}
    </>
  );
});

/** 过滤出日志视图可展示的 .log 文件,按修改时间倒序(壳侧 listLogFiles 已倒序,这里兜底重排)。 */
export function pickLogFiles(files: LogFileInfo[]): LogFileInfo[] {
  return files
    .filter((f) => f.name.endsWith('.log'))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** 默认展示最新的 daemon 日志(按天文件 daemon-YYYY-MM-DD.log,或旧版 daemon.log);缺失时回退到最新文件。 */
export function pickDefaultLogFile(files: LogFileInfo[]): string {
  if (files.length === 0) return '';
  const daemon = files.find(
    (f) => f.name !== 'daemon-stderr.log' && (f.name.startsWith('daemon-') || f.name === 'daemon.log'),
  );
  return daemon ? daemon.name : files[0].name;
}

export function LogSettings() {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [logContent, setLogContent] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logDir, setLogDir] = useState<string>('');
  const [lastRefresh, setLastRefresh] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const selectedFileRef = useRef('');

  // split 只随内容变化;父组件 3s 一次的重渲染不会重建数组 → memo 子组件跳过。
  const lines = useMemo(() => logContent.split('\n'), [logContent]);
  const visibleLines = useMemo(
    () => (lines.length > MAX_RENDER_LINES ? lines.slice(lines.length - MAX_RENDER_LINES) : lines),
    [lines],
  );

  const applyContent = useCallback((result: LogFileContent) => {
    // 更新前先记住用户是否贴着底部,决定是否自动跟到最新。
    const el = contentRef.current;
    if (el) {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }

    // 内容一致时保持原引用,避免无谓重渲染(轮询时绝大多数 tick 都是这种情况)。
    setLogContent((prev) => (prev === result.content ? prev : result.content));
    setTruncated(result.truncated);
    setError(null);
    setLastRefresh(new Date().toLocaleTimeString('zh-CN'));

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

      // 日志文件按天归档:daemon-YYYY-MM-DD.log / renderer-YYYY-MM-DD.log 等 .log 文件
      const logs = pickLogFiles(allFiles);
      setFiles(logs);
      if (logs.length === 0) {
        selectedFileRef.current = '';
        setSelectedFile('');
        setLogContent('');
        setTruncated(false);
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

  // Auto-refresh every 3 seconds(窗口隐藏时跳过,别在后台空转读文件)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadLatestLog();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
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

  const clipped = truncated || lines.length > MAX_RENDER_LINES;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end gap-2">
        {files.length > 1 && (
          <Select value={selectedFile} onValueChange={handleFileChange}>
            <SelectTrigger aria-label="日志文件" size="sm" className="w-52">
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
          variant="secondary"
          size="xs"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
        <Button
          variant="secondary"
          size="xs"
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

      {!error && clipped && (
        <div className="rounded-lg border border-border bg-[hsl(var(--surface-2))] px-4 py-2 text-xs text-muted-foreground">
          {lines.length > MAX_RENDER_LINES
            ? `仅显示最近 ${MAX_RENDER_LINES} 行(共 ${lines.length} 行)`
            : '日志文件较大,仅显示末尾部分'}
          ,完整日志请用「打开日志目录」查看。
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-[hsl(var(--surface-1))]">
        <div
          ref={contentRef}
          className="h-[60vh] overflow-auto p-4 font-mono text-code leading-relaxed"
        >
          {logContent ? (
            <LogLines lines={visibleLines} />
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
