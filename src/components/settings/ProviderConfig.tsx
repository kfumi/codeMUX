import { useState, type ReactNode } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Provider } from '../../types/provider';
import { getProviderModelList, modelsFromText, modelsToText } from '../../lib/providerModels';
import { normalizeOpenAIBaseUrl } from '../../lib/providerUrls';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { ArrowLeft, Loader2, Eye, EyeOff, Zap, Plus } from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function inferCodexProxyDefault(baseUrl: string): boolean {
  if (!baseUrl.trim()) return false;
  try {
    return new URL(normalizeOpenAIBaseUrl(baseUrl)).host.toLowerCase() !== 'api.openai.com';
  } catch {
    return true;
  }
}

function FormSection({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[13px] font-medium text-foreground/70">{label}</h4>
        {hint && <span className="text-xs text-foreground/38">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-foreground/55">{label}</label>
      {children}
    </div>
  );
}

export function ProviderConfigPanel() {
  const { config, updateProvider, deleteProvider, setActiveProvider, fetchModels, testProvider } = useSettingsStore();
  const providers = config?.providers ?? [];
  const activeId = config?.active_provider_id ?? null;

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [modelText, setModelText] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saveError, setSaveError] = useState('');

  const openEdit = (provider: Provider) => {
    setEditingProvider({ ...provider });
    setModelText(modelsToText(getProviderModelList(provider)));
    setIsNew(false);
    setShowKey(false);
    setFetchStatus('idle');
    setFetchMessage('');
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
      default_model: '',
      models: [],
      codex_needs_proxy: false,
    });
    setModelText('');
    setIsNew(true);
    setShowKey(false);
    setFetchStatus('idle');
    setFetchMessage('');
    setDeleteConfirm(false);
    setSaveError('');
  };

  const closeForm = () => {
    setEditingProvider(null);
    setFetchStatus('idle');
    setFetchMessage('');
    setSaveError('');
    setDeleteConfirm(false);
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    setSaveError('');

    const missing: string[] = [];
    const models = modelsFromText(modelText);
    if (!editingProvider.name?.trim()) missing.push('供应商名称');
    if (!editingProvider.api_key?.trim()) missing.push('API Key');
    if (!editingProvider.anthropic_base_url?.trim()) missing.push('Anthropic Base URL');
    if (!editingProvider.openai_base_url?.trim()) missing.push('OpenAI Base URL');
    if (models.length === 0) missing.push('模型列表');

    if (missing.length > 0) {
      setSaveError(`请填写 ${missing.join('、')}`);
      return;
    }

    const normalizedProvider: Provider = {
      ...editingProvider,
      default_model: models[0] ?? '',
      models,
      openai_base_url: normalizeOpenAIBaseUrl(editingProvider.openai_base_url),
      codex_needs_proxy: editingProvider.codex_needs_proxy ?? inferCodexProxyDefault(editingProvider.openai_base_url),
    };

    await updateProvider(normalizedProvider);
    if (isNew) {
      await setActiveProvider(normalizedProvider.id);
    }
    closeForm();
  };

  const handleActivate = async () => {
    if (!editingProvider) return;
    await setActiveProvider(editingProvider.id);
    closeForm();
  };

  const handleDelete = async () => {
    if (!editingProvider) return;
    await deleteProvider(editingProvider.id);
    closeForm();
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
    const url = editingProvider.anthropic_base_url || normalizeOpenAIBaseUrl(editingProvider.openai_base_url);

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
      const fetchedModelIds = models.map((model) => model.id);
      setModelText(modelsToText(fetchedModelIds));
      setEditingProvider({
        ...editingProvider,
        default_model: fetchedModelIds[0] ?? editingProvider.default_model,
        models: fetchedModelIds,
      });
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
    } finally {
      setIsFetchingModels(false);
    }
  };

  const updateField = (field: keyof Provider, value: string | number | boolean | undefined) => {
    if (!editingProvider) return;
    setEditingProvider({ ...editingProvider, [field]: value });
  };

  if (editingProvider) {
    return (
      <div className="animate-fade-in-up space-y-8">
        <div className="space-y-3">
          <button
            type="button"
            onClick={closeForm}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/60 transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回供应商列表
          </button>
          <h3 className="text-[22px] font-semibold tracking-tight text-foreground">
            {isNew ? '添加供应商' : (editingProvider.name || '未命名供应商')}
          </h3>
        </div>

        <FormSection label="基础信息">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="供应商名称">
              <Input
                value={editingProvider.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="如 OpenRouter"
              />
            </Field>
            <Field label="API Key">
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>
        </FormSection>

        <FormSection label="接口地址">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Anthropic Base URL">
              <Input
                value={editingProvider.anthropic_base_url}
                onChange={(e) => updateField('anthropic_base_url', e.target.value)}
                placeholder="https://api.anthropic.com"
              />
            </Field>
            <Field label="OpenAI Base URL">
              <Input
                value={editingProvider.openai_base_url}
                onChange={(e) => updateField('openai_base_url', e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
          </div>
        </FormSection>

        <FormSection label="模型配置" hint="每行一个，首行作为默认模型">
          <textarea
            aria-label="模型列表"
            value={modelText}
            onChange={(e) => {
              const nextModelText = e.target.value;
              const models = modelsFromText(nextModelText);
              setModelText(nextModelText);
              setEditingProvider({
                ...editingProvider,
                default_model: models[0] ?? '',
                models,
              });
            }}
            placeholder="每行一个模型，第一行作为默认模型"
            className="min-h-32 w-full resize-y rounded-xl border border-input/88 bg-background/92 px-3 py-2.5 font-mono text-sm leading-6 text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.018)] outline-none ring-offset-background transition-all duration-200 placeholder:font-sans placeholder:text-muted-foreground/74 focus:ring-2 focus:ring-ring/34 focus:ring-offset-2"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2">
              <Switch
                aria-label="1M 上下文"
                checked={!!editingProvider.context_1m}
                onCheckedChange={(c) => updateField('context_1m', c || undefined)}
              />
              <span className="text-sm text-foreground/65">1M 上下文</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleFetchModels}
              disabled={isFetchingModels || !editingProvider.api_key || !(editingProvider.anthropic_base_url || editingProvider.openai_base_url)}
              className="gap-1.5"
            >
              {isFetchingModels ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              获取列表
            </Button>
          </div>
          {fetchMessage && (
            <p className={cn('text-xs', fetchStatus === 'success' ? 'text-[hsl(var(--success))]' : 'text-[hsl(var(--destructive))]')}>
              {fetchMessage}
            </p>
          )}
        </FormSection>

        <FormSection label="Codex 路由">
          <div className="flex items-start justify-between gap-4 rounded-xl bg-muted/40 p-4">
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-medium text-foreground/90">需要本地路由映射</div>
              <p className="text-xs leading-relaxed text-foreground/55">
                如果供应商不是原生 OpenAI Responses API，或模型名不是 Codex 默认的 GPT 系列，请打开此开关。
              </p>
            </div>
            <Switch
              aria-label="需要本地路由映射"
              checked={editingProvider.codex_needs_proxy ?? inferCodexProxyDefault(editingProvider.openai_base_url)}
              onCheckedChange={(c) => updateField('codex_needs_proxy', c)}
            />
          </div>
        </FormSection>

        <FormSection label="计费配置" hint="可选，$/1M tokens">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="输入">
              <Input
                type="number"
                value={editingProvider.input_price ?? ''}
                onChange={(e) => updateField('input_price', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="3.00"
                step="0.01"
              />
            </Field>
            <Field label="缓存命中">
              <Input
                type="number"
                value={editingProvider.cache_read_price ?? ''}
                onChange={(e) => updateField('cache_read_price', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="0.30"
                step="0.01"
              />
            </Field>
            <Field label="输出">
              <Input
                type="number"
                value={editingProvider.output_price ?? ''}
                onChange={(e) => updateField('output_price', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="15.00"
                step="0.01"
              />
            </Field>
          </div>
        </FormSection>

        {saveError && (
          <p className="text-sm text-[hsl(var(--destructive))]">{saveError}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-5">
          <div>
            {!isNew && (
              deleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[hsl(var(--destructive))]">确认删除？</span>
                  <Button variant="destructive" size="sm" onClick={handleDelete}>确认</Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>取消</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-[hsl(var(--destructive))]" onClick={() => setDeleteConfirm(true)}>
                  删除
                </Button>
              )
            )}
          </div>
          <div className="flex gap-2">
            {!isNew && editingProvider.id !== activeId && (
              <Button variant="outline" onClick={handleActivate}>激活</Button>
            )}
            <Button variant="outline" onClick={closeForm}>取消</Button>
            <Button onClick={handleSave}>保存</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {providers.map((p) => {
          const active = p.id === activeId;
          return (
            <div
              key={p.id}
              className={cn(
                'group flex flex-col gap-2 rounded-xl border p-4 transition-all duration-200 cursor-pointer',
                active
                  ? 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.06)] shadow-[0_10px_28px_-20px_hsl(var(--primary)/0.5)]'
                  : 'border-border/50 bg-muted/30 hover:border-primary/40 hover:bg-muted/50',
              )}
              onClick={() => openEdit(p)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {p.name || '未命名'}
                </span>
                <button
                  title="测试连接"
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:opacity-50"
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
              </div>
              <div className="truncate font-mono text-xs text-foreground/50">
                {p.default_model || '未设置模型'}
              </div>
              <div className="flex items-center justify-between pt-1">
                {active ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--primary)/0.12)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--primary))]">
                    已激活
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveProvider(p.id);
                    }}
                  >
                    激活
                  </Button>
                )}
                <span className="text-[11px] text-foreground/35 opacity-0 transition-opacity group-hover:opacity-100">
                  点击编辑
                </span>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={openNew}
          className="flex min-h-22 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border/50 text-sm text-muted-foreground/60 transition-all duration-200 hover:border-primary/40 hover:text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
          添加供应商
        </button>
      </div>

      {toast && (
        <div
          className={cn(
            'fixed bottom-6 right-6 z-50 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg transition-all duration-300',
            toast.type === 'success' ? 'bg-[hsl(var(--success))] text-white' : 'bg-[hsl(var(--destructive))] text-white',
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
