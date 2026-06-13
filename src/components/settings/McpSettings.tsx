import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpStore } from '../../stores/mcpStore';
import type { McpServer, McpApps, McpServerSpec } from '../../types/mcp';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Plus, Pencil, Trash2, Loader2, Server, Wand2, Wand, RefreshCw, Download } from 'lucide-react';
import { toast } from 'sonner';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { cn } from '../../lib/utils';

// Agent brand SVGs for per-tool toggle icons
import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';

const APP_SVGS: Record<keyof McpApps, string> = {
  claude: claudeSvg,
  codex: openAiSvg,
  gemini: geminiSvg,
  opencode: opencodeSvg,
};

const APP_LABELS: Record<keyof McpApps, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

function AppIcon({ app, size = 16 }: { app: keyof McpApps; size?: number }) {
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

type TransportType = 'stdio' | 'http' | 'sse';

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function defaultServerSpec(type: TransportType): McpServerSpec {
  switch (type) {
    case 'stdio':
      return { type: 'stdio', command: '', args: [], env: {} };
    case 'http':
      return { type: 'http', url: '', headers: {} };
    case 'sse':
      return { type: 'sse', url: '', headers: {} };
  }
}

const baseTheme = EditorView.theme({
  '&': { fontSize: '13px', borderRadius: '8px', overflow: 'hidden' },
  '.cm-content': { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--accent) / 0.3)' },
});

const APP_ORDER: Array<keyof McpApps> = ['claude', 'codex', 'gemini', 'opencode'];

export function McpSettingsPanel() {
  const servers = useMcpStore((s) => s.servers);
  const probeStatus = useMcpStore((s) => s.probeStatus);
  const isLoading = useMcpStore((s) => s.isLoading);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const probeAll = useMcpStore((s) => s.probeAll);
  const probeServer = useMcpStore((s) => s.probeServer);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const toggleApp = useMcpStore((s) => s.toggleApp);
  const importFromApps = useMcpStore((s) => s.importFromApps);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);

  // wizard local state
  const [wizType, setWizType] = useState<TransportType>('stdio');
  const [wizName, setWizName] = useState('');
  const [wizCommand, setWizCommand] = useState('');
  const [wizArgs, setWizArgs] = useState('');
  const [wizEnv, setWizEnv] = useState('');
  const [wizUrl, setWizUrl] = useState('');
  const [wizHeaders, setWizHeaders] = useState('');

  const didFetchRef = useRef(false);
  useEffect(() => {
    if (didFetchRef.current) return;
    didFetchRef.current = true;
    fetchServers();
  }, [fetchServers]);

  const handleRefresh = () => {
    setProbing(true);
    probeAll().finally(() => setProbing(false));
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      await importFromApps();
      toast.success('导入完成');
    } catch {
      toast.error('导入失败');
    } finally {
      setImporting(false);
    }
  };

  const openNew = () => {
    const server: McpServer = {
      id: generateId(),
      name: '',
      description: '',
      server: defaultServerSpec('stdio'),
      apps: { claude: false, codex: false, gemini: false, opencode: false },
    };
    setEditing(server);
    setIsNew(true);
    setDeleteConfirm(false);
    setJsonText(JSON.stringify(server.server, null, 2));
    setJsonError('');
  };

  const openEdit = (server: McpServer) => {
    setEditing({ ...server });
    setIsNew(false);
    setDeleteConfirm(false);
    setJsonText(JSON.stringify(server.server, null, 2));
    setJsonError('');
  };

  const closeModal = () => {
    setEditing(null);
    setDeleteConfirm(false);
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);
      setJsonText(formatted);
      if (editing) {
        setEditing({ ...editing, server: parsed as McpServerSpec });
      }
      setJsonError('');
    } catch (e) {
      setJsonError(`JSON 格式错误: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleJsonChange = useCallback((value: string) => {
    setJsonText(value);
    try {
      const parsed = JSON.parse(value);
      if (editing) {
        setEditing({ ...editing, server: parsed as McpServerSpec });
      }
      setJsonError('');
    } catch (e) {
      setJsonError(`JSON 格式错误: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [editing]);

  const handleSave = async () => {
    if (!editing) return;

    if (!editing.name.trim()) {
      toast.error('请填写 MCP 名称');
      return;
    }
    const spec = editing.server;
    const serverType = (spec.type ?? 'stdio') as string;
    if (serverType === 'stdio' && !spec.command?.trim()) {
      toast.error('请填写 command');
      return;
    }
    if ((serverType === 'http' || serverType === 'sse') && !(spec.url as string)?.trim()) {
      toast.error('请填写 url');
      return;
    }

    const nameExists = servers.some(
      (s) => s.name === editing.name.trim() && s.id !== editing.id
    );
    if (nameExists) {
      toast.error('名称已存在');
      return;
    }

    try {
      await upsertServer({ ...editing, name: editing.name.trim() });
      toast.success('保存成功');
      closeModal();
    } catch {
      toast.error('保存失败');
    }
  };

  const openWizard = () => {
    if (!editing) return;
    const spec = editing.server;
    const serverType = (spec.type ?? 'stdio') as TransportType;
    setWizType(serverType);
    setWizName(editing.name);
    setWizCommand(serverType === 'stdio' ? (spec.command ?? '') : '');
    setWizArgs(serverType === 'stdio' ? (spec.args ?? []).join('\n') : '');
    setWizEnv(
      Object.entries(
        (serverType === 'stdio' ? spec.env : spec.headers) || {}
      ).map(([k, v]) => `${k}=${v}`).join('\n')
    );
    setWizUrl(serverType !== 'stdio' ? (spec.url ?? '') : '');
    setWizHeaders(
      serverType !== 'stdio'
        ? Object.entries(spec.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n')
        : ''
    );
    setWizardOpen(true);
  };

  const applyWizard = () => {
    if (!editing) return;

    if (!wizName.trim()) {
      toast.error('请填写 MCP 名称');
      return;
    }
    if (wizType === 'stdio' && !wizCommand.trim()) {
      toast.error('请填写命令');
      return;
    }
    if (wizType !== 'stdio' && !wizUrl.trim()) {
      toast.error('请填写 URL');
      return;
    }

    let spec: McpServerSpec;
    if (wizType === 'stdio') {
      const env: Record<string, string> = {};
      for (const line of wizEnv.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      spec = {
        type: 'stdio',
        command: wizCommand,
        args: wizArgs.split('\n').filter((a) => a.trim()),
        env,
      };
    } else {
      const headers: Record<string, string> = {};
      for (const line of wizHeaders.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      spec = { type: wizType, url: wizUrl, headers };
    }
    setEditing({ ...editing, name: wizName, server: spec });
    setJsonText(JSON.stringify(spec, null, 2));
    setJsonError('');
    setWizardOpen(false);
  };

  const transportBadge = (type: string) => {
    const colors: Record<string, string> = {
      stdio: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      http: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      sse: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
    };
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${colors[type] ?? 'bg-gray-100 text-gray-700'}`}>
        {type}
      </span>
    );
  };

  const textareaClass =
    "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pr-12">
        <h3 className="font-medium">MCP Servers</h3>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleImport} disabled={importing}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
            从工具导入
          </Button>
          <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={probing}>
            <RefreshCw className={`h-4 w-4 ${probing ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            添加
          </Button>
        </div>
      </div>

      {isLoading && servers.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          加载中...
        </div>
      )}

      {!isLoading && servers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Server className="h-8 w-8 mb-2 opacity-50" />
          <p className="text-sm">暂无 MCP Server</p>
          <p className="text-xs">点击"从工具导入"或"添加"按钮</p>
        </div>
      )}

      <div className="space-y-2">
        {servers.map((server) => {
          const serverType = (server.server.type ?? 'stdio') as string;
          const anyEnabled = Object.values(server.apps).some(Boolean);
          return (
            <div
              key={server.id}
              className="flex flex-col gap-2 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full flex-shrink-0 ${
                        anyEnabled
                          ? probeStatus[server.id] === 'connected' ? 'bg-green-500'
                            : probeStatus[server.id] === 'pending' ? 'bg-yellow-500'
                            : probeStatus[server.id] === 'failed' ? 'bg-red-500'
                            : 'bg-gray-400'
                          : 'bg-gray-300'
                      }`}
                    />
                    <span className="font-medium text-sm truncate">{server.name}</span>
                    {transportBadge(serverType)}
                  </div>
                  {server.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5 ml-4">
                      {server.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {APP_ORDER.map((app) => (
                    <button
                      key={app}
                      aria-label={`toggle-${server.id}-${app}`}
                      title={APP_LABELS[app]}
                      onClick={() => toggleApp(server.id, app, !server.apps[app])}
                      className={cn(
                        'inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors',
                        server.apps[app]
                          ? 'bg-primary/10 border-primary/30'
                          : 'bg-background border-transparent opacity-40 hover:opacity-70',
                      )}
                    >
                      <AppIcon app={app} size={16} />
                    </button>
                  ))}
                </div>
                <div className="flex items-center -space-x-1">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => probeServer(server.id)}>
                    <RefreshCw className={`h-3 w-3 ${probeStatus[server.id] === 'pending' ? 'animate-spin' : ''}`} />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(server)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => { setDeletingId(server.id); setDeleteConfirm(true); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 编辑/新建弹窗 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-[560px] px-10 pt-8 pb-6">
          <DialogHeader>
            <DialogTitle>{isNew ? '添加 MCP Server' : '编辑 MCP Server'}</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">名称（唯一） <span className="text-destructive">*</span></label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如 context7"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">描述</label>
                <Input
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  placeholder="例如 @upstash/context7-mcp — 文档查询服务"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="space-y-0.5">
                  <label className="text-sm font-medium">启用到工具</label>
                  <p className="text-xs text-muted-foreground">
                    选择哪些工具使用此 MCP server
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {APP_ORDER.map((app) => (
                    <button
                      key={app}
                      aria-label={`toggle-edit-${app}`}
                      title={APP_LABELS[app]}
                      onClick={() => setEditing({
                        ...editing,
                        apps: { ...editing.apps, [app]: !editing.apps[app] }
                      })}
                      className={cn(
                        'inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors',
                        editing.apps[app]
                          ? 'bg-primary/10 border-primary/30'
                          : 'bg-background border-transparent opacity-40 hover:opacity-70',
                      )}
                    >
                      <AppIcon app={app} size={20} />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">完整的 JSON 配置</label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={formatJson}
                    >
                      <Wand className="h-4 w-4 mr-1" />
                      格式化
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={openWizard}
                    >
                      <Wand2 className="h-4 w-4 mr-1" />
                      配置向导
                    </Button>
                  </div>
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <CodeMirror
                    value={jsonText}
                    height="260px"
                    extensions={[json(), EditorView.lineWrapping]}
                    theme={baseTheme}
                    onChange={handleJsonChange}
                  />
                </div>
                {jsonError && (
                  <p className="text-xs text-destructive">
                    {jsonError}
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex justify-between">
            <div />
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeModal}>
                取消
              </Button>
              <Button onClick={handleSave}>
                {isNew ? '添加' : '保存'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="text-destructive">⚠</span>
              删除 MCP
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要删除 MCP "{servers.find((s) => s.id === deletingId)?.name}" 吗？此操作无法撤销。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>取消</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (deletingId) {
                  await deleteServer(deletingId);
                  toast.success('已删除');
                }
                setDeleteConfirm(false);
                setDeletingId(null);
              }}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MCP 配置向导弹窗 */}
      <Dialog open={wizardOpen} onOpenChange={(open) => !open && setWizardOpen(false)}>
        <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <DialogHeader>
            <DialogTitle>MCP 配置向导</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="space-y-4">
              <div className="space-y-3">
                <label className="text-sm font-medium">类型 <span className="text-destructive">*</span></label>
                <RadioGroup
                  value={wizType}
                  onValueChange={(v) => setWizType(v as TransportType)}
                  className="flex gap-6"
                >
                  {(['stdio', 'http', 'sse'] as TransportType[]).map((type) => (
                    <div key={type} className="flex items-center gap-2">
                      <RadioGroupItem value={type} id={`wiz-${type}`} />
                      <label htmlFor={`wiz-${type}`} className="text-sm cursor-pointer select-none">
                        {type}
                      </label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">名称（唯一） <span className="text-destructive">*</span></label>
                <Input
                  value={wizName}
                  onChange={(e) => setWizName(e.target.value)}
                  placeholder="my-mcp-server"
                />
              </div>

              {wizType === 'stdio' ? (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">命令 <span className="text-destructive">*</span></label>
                    <Input
                      value={wizCommand}
                      onChange={(e) => setWizCommand(e.target.value)}
                      placeholder="npx 或 uvx"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">参数（每行一个）</label>
                    <textarea
                      className={textareaClass}
                      value={wizArgs}
                      onChange={(e) => setWizArgs(e.target.value)}
                      placeholder={"arg1\narg2\n"}
                      rows={4}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">环境变量（KEY=VALUE，每行一个）</label>
                    <textarea
                      className={textareaClass}
                      value={wizEnv}
                      onChange={(e) => setWizEnv(e.target.value)}
                      placeholder={"KEY1=value1\nKEY2=value2"}
                      rows={3}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">URL <span className="text-destructive">*</span></label>
                    <Input
                      value={wizUrl}
                      onChange={(e) => setWizUrl(e.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Headers（KEY=VALUE，每行一个）</label>
                    <textarea
                      className={textareaClass}
                      value={wizHeaders}
                      onChange={(e) => setWizHeaders(e.target.value)}
                      placeholder={"Authorization=Bearer xxx"}
                      rows={3}
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">配置预览</label>
                <div className="rounded-lg border bg-muted p-3 overflow-x-auto">
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre">
                    {JSON.stringify(
                      (() => {
                        if (wizType === 'stdio') {
                          const env: Record<string, string> = {};
                          for (const line of wizEnv.split('\n')) {
                            const idx = line.indexOf('=');
                            if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                          }
                          return {
                            type: wizType,
                            command: wizCommand,
                            args: wizArgs.split('\n').filter((a) => a.trim()),
                            env,
                          };
                        }
                        const headers: Record<string, string> = {};
                        for (const line of wizHeaders.split('\n')) {
                          const idx = line.indexOf('=');
                          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                        }
                        return { type: wizType, url: wizUrl, headers };
                      })(),
                      null,
                      2
                    )}
                  </pre>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setWizardOpen(false)}>
              取消
            </Button>
            <Button onClick={applyWizard}>
              应用配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
