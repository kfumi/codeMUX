import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Provider } from '../../types/provider';
import type { ModelInfo } from '../../lib/tauri';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select';
import { Loader2, Eye, EyeOff } from 'lucide-react';

const BUILT_IN_MODELS: ModelInfo[] = [
  { id: 'claude-opus', owned_by: 'anthropic' },
  { id: 'claude-sonnet', owned_by: 'anthropic' },
  { id: 'claude-haiku', owned_by: 'anthropic' },
];

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function maskKey(key: string): string {
  if (!key) return '未设置';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

function groupModels(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const key = m.owned_by || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  // Sort groups by key alphabetically
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function ProviderConfigPanel() {
  const { config, updateProvider, deleteProvider, setActiveProvider, fetchModels } = useSettingsStore();
  const providers = config?.providers ?? [];
  const activeId = config?.active_provider_id ?? null;

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const openEdit = (provider: Provider) => {
    setEditingProvider({ ...provider });
    setIsNew(false);
    setShowKey(false);
    // Seed available models with the current default so the Select can display it
    if (provider.default_model && !BUILT_IN_MODELS.some((m) => m.id === provider.default_model)) {
      setAvailableModels([{ id: provider.default_model, owned_by: 'current' }]);
    } else {
      setAvailableModels([]);
    }
    setFetchStatus('idle');
    setDeleteConfirm(false);
  };

  const openNew = () => {
    setEditingProvider({
      id: generateId(),
      name: '',
      api_key: '',
      anthropic_base_url: '',
      openai_base_url: '',
      default_model: BUILT_IN_MODELS[1].id,
    });
    setIsNew(true);
    setShowKey(false);
    setAvailableModels([]);
    setFetchStatus('idle');
    setDeleteConfirm(false);
  };

  const closeModal = () => {
    setEditingProvider(null);
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    await updateProvider(editingProvider);
    if (isNew) {
      await setActiveProvider(editingProvider.id);
    }
    closeModal();
  };

  const handleActivate = async () => {
    if (!editingProvider) return;
    await setActiveProvider(editingProvider.id);
    closeModal();
  };

  const handleDelete = async () => {
    if (!editingProvider) return;
    await deleteProvider(editingProvider.id);
    closeModal();
  };

  const handleFetchModels = async () => {
    if (!editingProvider) return;
    const url = editingProvider.anthropic_base_url || editingProvider.openai_base_url;

    if (!url?.trim()) {
      setFetchStatus('error');
      setFetchMessage('请填写 Base URL');
      return;
    }
    if (!editingProvider.api_key?.trim()) {
      setFetchStatus('error');
      setFetchMessage('请填写 API Key');
      return;
    }

    setIsFetchingModels(true);
    setFetchStatus('idle');
    setFetchMessage('');
    try {
      const models = await fetchModels(editingProvider.api_key, url);
      setAvailableModels(models);
      setFetchStatus('success');
      setFetchMessage(`获取到 ${models.length} 个模型`);
    } catch (err) {
      const msg = String(err);
      setFetchStatus('error');
      if (msg.includes('认证失败')) {
        setFetchMessage('认证失败，请检查 API Key');
      } else if (msg.includes('未找到')) {
        setFetchMessage('接口地址未找到');
      } else if (msg.includes('超时')) {
        setFetchMessage('请求超时');
      } else if (msg.includes('不支持')) {
        setFetchMessage('该接口不支持获取模型');
      } else {
        setFetchMessage(`获取失败: ${msg}`);
      }
      setAvailableModels(BUILT_IN_MODELS);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const updateField = (field: keyof Provider, value: string) => {
    if (!editingProvider) return;
    setEditingProvider({ ...editingProvider, [field]: value });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">供应商配置</h3>
      <p className="text-sm text-muted-foreground">管理 AI 供应商，激活的供应商将用于智能体。</p>

      {/* Provider cards */}
      <div className="flex flex-wrap gap-3">
        {providers.map((p) => (
          <div
            key={p.id}
            onClick={() => openEdit(p)}
            className="w-[200px] p-3 bg-card border rounded-lg cursor-pointer hover:border-primary/50 transition-colors"
            style={{
              borderColor: p.id === activeId ? 'hsl(var(--primary))' : undefined,
              borderWidth: p.id === activeId ? '2px' : '1px',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-sm truncate">{p.name || '未命名'}</span>
              {p.id === activeId && (
                <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
                  激活
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">{p.default_model}</div>
            <div className="text-xs text-muted-foreground/60 mt-1">{maskKey(p.api_key)}</div>
          </div>
        ))}

        {/* Add card */}
        <div
          onClick={openNew}
          className="w-[200px] p-3 border border-dashed rounded-lg cursor-pointer hover:border-primary/50 transition-colors flex items-center justify-center min-h-[88px]"
        >
          <span className="text-sm text-muted-foreground">+ 添加供应商</span>
        </div>
      </div>

      {/* Edit modal */}
      <Dialog open={!!editingProvider} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{isNew ? '添加供应商' : '编辑供应商'}</DialogTitle>
          </DialogHeader>

          {editingProvider && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">供应商名称</label>
                <Input
                  value={editingProvider.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="如 OpenRouter"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={editingProvider.api_key}
                    onChange={(e) => updateField('api_key', e.target.value)}
                    placeholder="输入 API Key"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Anthropic Base URL</label>
                  <Input
                    value={editingProvider.anthropic_base_url}
                    onChange={(e) => updateField('anthropic_base_url', e.target.value)}
                    placeholder="https://api.anthropic.com"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">OpenAI Base URL</label>
                  <Input
                    value={editingProvider.openai_base_url}
                    onChange={(e) => updateField('openai_base_url', e.target.value)}
                    placeholder="可选"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">默认模型</label>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Select
                      value={editingProvider.default_model}
                      onValueChange={(value) => updateField('default_model', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[...groupModels(availableModels.length > 0 ? availableModels : BUILT_IN_MODELS).entries()].map(([group, models]) => (
                          <SelectGroup key={group}>
                            <SelectLabel>{group}</SelectLabel>
                            {models.map((m) => (
                              <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFetchModels}
                    disabled={isFetchingModels || !editingProvider.api_key || !(editingProvider.anthropic_base_url || editingProvider.openai_base_url)}
                    className="shrink-0"
                  >
                    {isFetchingModels ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      '获取列表'
                    )}
                  </Button>
                </div>
                {fetchMessage && (
                  <p className={`text-xs mt-1 ${fetchStatus === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {fetchMessage}
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex justify-between">
            <div>
              {!isNew && (
                deleteConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-500">确认删除？</span>
                    <Button variant="destructive" size="sm" onClick={handleDelete}>确认</Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>取消</Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="text-red-500" onClick={() => setDeleteConfirm(true)}>
                    删除
                  </Button>
                )
              )}
            </div>
            <div className="flex gap-2">
              {!isNew && editingProvider?.id !== activeId && (
                <Button variant="outline" onClick={handleActivate}>激活</Button>
              )}
              <Button variant="outline" onClick={closeModal}>取消</Button>
              <Button onClick={handleSave}>保存</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
