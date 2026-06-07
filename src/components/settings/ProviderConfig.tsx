import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Provider } from '../../types/provider';
import type { ModelInfo } from '../../lib/tauri';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select';
import { Loader2, Eye, EyeOff, Zap } from 'lucide-react';

const BUILT_IN_MODELS: ModelInfo[] = [
  { id: 'claude-opus', owned_by: 'anthropic' },
  { id: 'claude-sonnet', owned_by: 'anthropic' },
  { id: 'claude-haiku', owned_by: 'anthropic' },
];

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
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
  const { config, updateProvider, deleteProvider, setActiveProvider, fetchModels, testProvider } = useSettingsStore();
  const providers = config?.providers ?? [];
  const activeId = config?.active_provider_id ?? null;

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saveError, setSaveError] = useState('');

  const openEdit = (provider: Provider) => {
    setEditingProvider({ ...provider });
    setIsNew(false);
    setShowKey(false);
    setAvailableModels([]);
    setFetchStatus('idle');
    setDeleteConfirm(false);
    setSaveError('');
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
    setSaveError('');
  };

  const closeModal = () => {
    setEditingProvider(null);
    setFetchStatus('idle');
    setFetchMessage('');
    setSaveError('');
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    setSaveError('');

    const missing: string[] = [];
    if (!editingProvider.name?.trim()) missing.push('供应商名称');
    if (!editingProvider.api_key?.trim()) missing.push('API Key');
    if (!editingProvider.anthropic_base_url?.trim()) missing.push('Anthropic Base URL');
    if (!editingProvider.openai_base_url?.trim()) missing.push('OpenAI Base URL');
    if (!editingProvider.default_model?.trim()) missing.push('默认模型');

    if (missing.length > 0) {
      setSaveError(`请填写: ${missing.join('、')}`);
      return;
    }

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

  const handleTest = async (providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    const name = provider?.name || '未知';
    setTestingId(providerId);
    const start = Date.now();
    try {
      await testProvider(providerId);
      const ms = Date.now() - start;
      setToast({ message: `${name} 运行正常 (${ms}ms)`, type: 'success' });
    } catch (err) {
      const ms = Date.now() - start;
      setToast({ message: `${name} 连接失败 (${ms}ms): ${err}`, type: 'error' });
    } finally {
      setTestingId(null);
      setTimeout(() => setToast(null), 4000);
    }
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

  const updateField = (field: keyof Provider, value: string | number | boolean | undefined) => {
    if (!editingProvider) return;
    setEditingProvider({ ...editingProvider, [field]: value });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">供应商配置</h3>
      <p className="text-sm text-muted-foreground">管理 AI 供应商，激活的供应商将用于智能体。</p>

      {/* Provider cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {providers.map((p) => (
          <div
            key={p.id}
            className="p-3 bg-card border rounded-lg transition-colors cursor-pointer hover:border-primary/50"
            style={{
              borderColor: p.id === activeId ? 'hsl(var(--primary))' : undefined,
              borderWidth: p.id === activeId ? '2px' : '1px',
            }}
            onClick={() => openEdit(p)}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-sm truncate">
                {p.name || '未命名'}
              </span>
              <div className="flex items-center gap-1">
                <button
                  title="测试模型"
                  className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  disabled={testingId === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTest(p.id);
                  }}
                >
                  {testingId === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                </button>
                <Button
                  variant={p.id === activeId ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveProvider(p.id);
                  }}
                >
                  {p.id === activeId ? '已激活' : '激活'}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {p.default_model}
            </div>
          </div>
        ))}

        {/* Add card */}
        <div
          onClick={openNew}
          className="p-3 border border-dashed rounded-lg cursor-pointer hover:border-primary/50 transition-colors flex items-center justify-center min-h-[88px]"
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

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">默认模型</label>
                <div className="flex gap-2">
                  <div className="flex-1">
                    {availableModels.length > 0 ? (
                      <Select
                        value={editingProvider.default_model}
                        onValueChange={(value) => updateField('default_model', value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[...groupModels(availableModels).entries()].map(([group, models]) => (
                            <SelectGroup key={group}>
                              <SelectLabel>{group}</SelectLabel>
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={editingProvider.default_model}
                        onChange={(e) => updateField('default_model', e.target.value)}
                        placeholder="如 claude-sonnet-4-20250514"
                      />
                    )}
                  </div>
                  <label className="flex items-center gap-1.5 px-2.5 rounded-md border border-input bg-background text-xs cursor-pointer select-none shrink-0 hover:bg-accent/50 transition-colors">
                    <input
                      type="checkbox"
                      checked={!!editingProvider.context_1m}
                      onChange={(e) => updateField('context_1m', e.target.checked ? true : undefined)}
                      className="accent-primary w-3.5 h-3.5"
                    />
                    <span className="text-muted-foreground">1M</span>
                  </label>
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

              <div className="pt-1">
                <label className="text-xs text-muted-foreground mb-1.5 block">计费配置 <span className="text-muted-foreground/50">（可选，$/1M tokens）</span></label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[11px] text-muted-foreground/70 mb-0.5 block">输入</label>
                    <Input
                      type="number"
                      value={editingProvider.input_price ?? ''}
                      onChange={(e) => updateField('input_price', e.target.value ? Number(e.target.value) : undefined)}
                      placeholder="3.00"
                      step="0.01"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground/70 mb-0.5 block">缓存命中</label>
                    <Input
                      type="number"
                      value={editingProvider.cache_read_price ?? ''}
                      onChange={(e) => updateField('cache_read_price', e.target.value ? Number(e.target.value) : undefined)}
                      placeholder="0.30"
                      step="0.01"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground/70 mb-0.5 block">输出</label>
                    <Input
                      type="number"
                      value={editingProvider.output_price ?? ''}
                      onChange={(e) => updateField('output_price', e.target.value ? Number(e.target.value) : undefined)}
                      placeholder="15.00"
                      step="0.01"
                    />
                  </div>
                </div>
              </div>

            </div>
          )}

          {saveError && (
            <p className="text-xs text-red-500 -mt-1">{saveError}</p>
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

      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all duration-300 ${
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
