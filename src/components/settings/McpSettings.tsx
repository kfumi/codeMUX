import { useState, useEffect, useCallback } from 'react';
import { useMcpStore } from '../../stores/mcpStore';
import type { McpServer, McpTransport, McpTransportType } from '../../types/mcp';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Plus, Pencil, Trash2, Loader2, Server, Wand2, Wand } from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function defaultTransport(type: McpTransportType): McpTransport {
  switch (type) {
    case 'stdio':
      return { type: 'stdio', command: '', args: [], env: {} };
    case 'http':
      return { type: 'http', url: '', headers: {} };
    case 'sse':
      return { type: 'sse', url: '', headers: {} };
  }
}

export function McpSettingsPanel() {
  const { servers, isLoading, fetchServers, upsertServer, deleteServer, toggleServer } = useMcpStore();
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const openNew = () => {
    const now = new Date().toISOString();
    setEditing({
      id: generateId(),
      name: '',
      description: '',
      transport: defaultTransport('stdio'),
      enabled: true,
      created_at: now,
      updated_at: now,
    });
    setIsNew(true);
    setSaveError('');
    setDeleteConfirm(false);
  };

  const openEdit = (server: McpServer) => {
    setEditing({ ...server });
    setIsNew(false);
    setSaveError('');
    setDeleteConfirm(false);
    setJsonText(JSON.stringify(server.transport, null, 2));
    setJsonError('');
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError('');
    } catch (e) {
      setJsonError(`JSON 格式错误，请检查: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    validateJson(text);
  };

  const validateJson = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (editing) {
        setEditing({ ...editing, transport: parsed as McpTransport });
      }
      setJsonError('');
      return true;
    } catch (e) {
      setJsonError(`JSON 格式错误，请检查: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [editing]);

  const closeModal = () => {
    setEditing(null);
    setSaveError('');
    setDeleteConfirm(false);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaveError('');

    if (!editing.name.trim()) {
      setSaveError('请填写名称');
      return;
    }
    const t = editing.transport;
    if (t.type === 'stdio' && !t.command.trim()) {
      setSaveError('请填写 command');
      return;
    }
    if ((t.type === 'http' || t.type === 'sse') && !t.url.trim()) {
      setSaveError('请填写 url');
      return;
    }

    const nameExists = servers.some(
      (s) => s.name === editing.name.trim() && s.id !== editing.id
    );
    if (nameExists) {
      setSaveError('名称已存在');
      return;
    }

    try {
      await upsertServer({ ...editing, name: editing.name.trim() });
      closeModal();
    } catch {
      setSaveError('保存失败');
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    try {
      await deleteServer(editing.id);
      closeModal();
    } catch {
      // error handled by store
    }
  };

  const handleToggle = async (id: string) => {
    await toggleServer(id);
  };

  const updateTransportType = (type: McpTransportType) => {
    if (!editing) return;
    setEditing({ ...editing, transport: defaultTransport(type) });
  };

  const updateTransportField = (field: string, value: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      transport: { ...editing.transport, [field]: value } as McpTransport,
    });
  };

  const updateArgs = (argsStr: string) => {
    if (!editing || editing.transport.type !== 'stdio') return;
    const args = argsStr.split('\n').filter((a) => a.trim());
    setEditing({
      ...editing,
      transport: { ...editing.transport, args },
    });
  };

  const updateKeyValue = (field: 'headers' | 'env', raw: string) => {
    if (!editing) return;
    const obj: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    setEditing({
      ...editing,
      transport: { ...editing.transport, [field]: obj } as McpTransport,
    });
  };

  const transportBadge = (type: McpTransportType) => {
    const colors = {
      stdio: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      http: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      sse: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
    };
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${colors[type]}`}>
        {type}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">MCP Servers</h3>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" />
          添加
        </Button>
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
          <p className="text-xs">点击上方按钮添加</p>
        </div>
      )}

      <div className="space-y-2">
        {servers.map((server) => (
          <div
            key={server.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{server.name}</span>
                {transportBadge(server.transport.type)}
              </div>
              {server.description && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {server.description}
                </p>
              )}
            </div>
            <Switch
              checked={server.enabled}
              onCheckedChange={() => handleToggle(server.id)}
            />
            <Button variant="ghost" size="sm" onClick={() => openEdit(server)}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* 编辑/新建弹窗 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{isNew ? '添加 MCP Server' : '编辑 MCP Server'}</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">MCP 标题（唯一） *</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如 context7"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">显示名称</label>
                <Input
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  placeholder="例如 @upstash/context7-mcp"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">完整的 JSON 配置</label>
                <textarea
                  className="w-full h-64 rounded-lg border bg-muted p-4 overflow-auto text-xs font-mono text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                  value={jsonText}
                  onChange={(e) => handleJsonChange(e.target.value)}
                  spellCheck={false}
                />
                <div className="flex justify-between items-center">
                  {jsonError && (
                    <p className="text-sm text-destructive flex items-center gap-2">
                      <span className="text-destructive">⊘</span>
                      {jsonError}
                    </p>
                  )}
                  {!jsonError && <div />}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={formatJson}
                  >
                    <Wand className="h-4 w-4 mr-1" />
                    格式化
                  </Button>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setWizardOpen(true)}
              >
                <Wand2 className="h-4 w-4 mr-1" />
                配置向导
              </Button>

              {saveError && (
                <p className="text-sm text-destructive">{saveError}</p>
              )}
            </div>
          )}

          <DialogFooter className="flex justify-between">
            {!isNew && (
              <>
                {deleteConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-destructive">确认删除？</span>
                    <Button variant="destructive" size="sm" onClick={handleDelete}>
                      删除
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(true)}>
                    <Trash2 className="h-4 w-4 mr-1" />
                    删除
                  </Button>
                )}
              </>
            )}
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

      {/* 配置向导弹窗 */}
      <Dialog open={wizardOpen} onOpenChange={(open) => !open && setWizardOpen(false)}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto p-0">
          <div className="p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                MCP 配置向导
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                快速配置 MCP 服务器传输参数，JSON 配置会自动更新
              </p>
            </div>

            {editing && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    类型 *
                  </label>
                  <div className="flex gap-4">
                    {(['stdio', 'http', 'sse'] as McpTransportType[]).map((type) => (
                      <div key={type} className="flex items-center gap-2">
                        <input
                          type="radio"
                          id={`wizard-type-${type}`}
                          name="wizardTransportType"
                          value={type}
                          checked={editing.transport.type === type}
                          onChange={() => updateTransportType(type)}
                          className="h-4 w-4 text-primary border-primary focus:ring-primary"
                        />
                        <label htmlFor={`wizard-type-${type}`} className="text-sm cursor-pointer">
                          {type}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    MCP 标题（唯一） *
                  </label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="例如 context7"
                  />
                </div>

                {editing.transport.type === 'stdio' && (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        命令 *
                      </label>
                      <Input
                        value={editing.transport.command}
                        onChange={(e) => updateTransportField('command', e.target.value)}
                        placeholder="例如 cmd"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        参数（每行一个）
                      </label>
                      <textarea
                        className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={(editing.transport.args || []).join('\n')}
                        onChange={(e) => updateArgs(e.target.value)}
                        placeholder={"/c\nnpx\n-y\n@upstash/context7-mcp"}
                        rows={4}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        环境变量（KEY=VALUE，每行一个）
                      </label>
                      <textarea
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={Object.entries(editing.transport.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                        onChange={(e) => updateKeyValue('env', e.target.value)}
                        placeholder={"API_KEY=xxx"}
                        rows={3}
                      />
                    </div>
                  </>
                )}

                {editing.transport.type !== 'stdio' && (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        URL *
                      </label>
                      <Input
                        value={editing.transport.url}
                        onChange={(e) => updateTransportField('url', e.target.value)}
                        placeholder="https://example.com/mcp"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        Headers（KEY=VALUE，每行一个）
                      </label>
                      <textarea
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={Object.entries(editing.transport.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                        onChange={(e) => updateKeyValue('headers', e.target.value)}
                        placeholder={"Authorization=Bearer xxx"}
                        rows={3}
                      />
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    配置预览
                  </label>
                  <div className="rounded-lg border bg-muted p-4 overflow-x-auto">
                    <pre className="text-xs font-mono text-foreground whitespace-pre">
                      {JSON.stringify(editing.transport, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="px-6 pb-6 gap-2">
            <Button variant="outline" onClick={() => setWizardOpen(false)}>
              取消
            </Button>
            <Button onClick={() => {
              if (editing) {
                setJsonText(JSON.stringify(editing.transport, null, 2));
                setJsonError('');
              }
              setWizardOpen(false);
            }}>
              应用配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
