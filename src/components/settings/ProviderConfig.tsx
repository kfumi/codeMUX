import { useEffect, useMemo, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { configApi } from '@/lib/tauri';
import { isProviderUsable, providerUnusableReason } from '@/lib/modelProviders';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  BuiltinProviderTemplate,
  ModelProvider,
  Protocol,
  ProtocolEndpoint,
  ProviderModel,
} from '@/types/provider';

function emptyCustomProvider(): ModelProvider {
  return {
    id: crypto.randomUUID(),
    name: '自定义供应商',
    enabled: true,
    api_key: '',
    endpoints: [
      {
        protocol: 'openai_compatible',
        base_url: '',
        api_key_override: null,
        codex_needs_proxy: true,
      },
    ],
    models: [{ id: 'default-model', name: 'Default Model' }],
    default_model: 'default-model',
    builtin_template_id: null,
    opencode_provider_key: 'codemux-openai',
    opencode_npm: '@ai-sdk/openai-compatible',
  };
}

function endpointLabel(protocol: Protocol): string {
  return protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
}

function ensureEndpoint(
  endpoints: ProtocolEndpoint[],
  protocol: Protocol,
  baseUrl: string,
): ProtocolEndpoint[] {
  const existing = endpoints.find((item) => item.protocol === protocol);
  if (existing) {
    return endpoints.map((item) =>
      item.protocol === protocol ? { ...item, base_url: baseUrl } : item,
    );
  }
  return [
    ...endpoints,
    {
      protocol,
      base_url: baseUrl,
      api_key_override: null,
      codex_needs_proxy: protocol === 'openai_compatible' ? true : null,
    },
  ];
}

export function ProviderConfigPanel() {
  const {
    config,
    fetchConfig,
    upsertModelProvider,
    deleteModelProvider,
    setActiveProvider,
    setModelProviderEnabled,
    instantiateBuiltinTemplate,
    testModelProvider,
  } = useSettingsStore();

  const providers = config?.model_providers ?? [];
  const activeId = config?.active_provider_id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelProvider | null>(null);
  const [templates, setTemplates] = useState<BuiltinProviderTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    void fetchConfig();
    void configApi.listBuiltinProviderTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [fetchConfig]);

  useEffect(() => {
    if (!selectedId && providers[0]) {
      setSelectedId(providers[0].id);
    }
  }, [providers, selectedId]);

  useEffect(() => {
    const selected = providers.find((provider) => provider.id === selectedId) ?? null;
    setDraft(selected ? structuredClone(selected) : null);
  }, [providers, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((provider) => provider.name.toLowerCase().includes(q));
  }, [providers, search]);

  const anthropicUrl =
    draft?.endpoints.find((endpoint) => endpoint.protocol === 'anthropic')?.base_url ?? '';
  const openaiUrl =
    draft?.endpoints.find((endpoint) => endpoint.protocol === 'openai_compatible')?.base_url ?? '';
  const modelsText = (draft?.models ?? []).map((model) => model.id).join('\n');

  async function handleSave() {
    if (!draft) return;
    const cleaned: ModelProvider = {
      ...draft,
      endpoints: draft.endpoints.filter((endpoint) => endpoint.base_url.trim().length > 0),
    };
    if (cleaned.endpoints.length === 0) {
      toast.error('至少填写一个协议端点 URL');
      return;
    }
    setSaving(true);
    try {
      await upsertModelProvider(cleaned);
      toast.success('供应商已保存');
      setSelectedId(cleaned.id);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCustom() {
    const provider = emptyCustomProvider();
    setSelectedId(provider.id);
    setDraft(provider);
  }

  async function handleInstantiate(templateId: string) {
    try {
      const provider = await instantiateBuiltinTemplate(templateId);
      setSelectedId(provider.id);
      toast.success(`已添加 ${provider.name}，请填写 API Key`);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function handleDelete() {
    if (!draft) return;
    if (!window.confirm(`确认删除供应商「${draft.name}」？`)) return;
    try {
      await deleteModelProvider(draft.id);
      setSelectedId(null);
      toast.success('已删除');
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex w-64 shrink-0 flex-col gap-3 border-r border-border/60 pr-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索供应商"
        />
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {filtered.map((provider) => {
            const active = provider.id === activeId;
            const selected = provider.id === selectedId;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setSelectedId(provider.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm',
                  selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50 text-muted-foreground',
                )}
              >
                <span className="truncate font-medium text-foreground">{provider.name}</span>
                <span className="flex items-center gap-1">
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      provider.enabled && provider.api_key.trim() ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                  />
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无供应商</div>
          )}
        </div>
        <div className="space-y-2 border-t border-border/60 pt-3">
          <Button variant="outline" className="w-full justify-start" onClick={() => void handleAddCustom()}>
            <Plus className="mr-2 h-4 w-4" />
            添加自定义
          </Button>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {templates.map((template) => (
              <Button
                key={template.id}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs"
                onClick={() => void handleInstantiate(template.id)}
              >
                + {template.name}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto pr-1">
        {!draft ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            从左侧选择或添加供应商
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{draft.name}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  CodeMUX 自维护配置；对话时动态注入 SDK，不写入智能体原生配置文件。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="provider-enabled" className="text-xs text-muted-foreground">
                  启用
                </label>
                <Switch
                  id="provider-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => {
                    setDraft({ ...draft, enabled });
                    if (providers.some((item) => item.id === draft.id)) {
                      void setModelProviderEnabled(draft.id, enabled).catch((error) =>
                        toast.error(String(error)),
                      );
                    }
                  }}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">名称</label>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">API Key</label>
              <Input
                type="password"
                value={draft.api_key}
                onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                placeholder="必填；空值视为未配置"
              />
            </div>

            <div className="grid gap-3 rounded-xl border border-border/60 p-4">
              <div className="text-sm font-medium">协议端点</div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">{endpointLabel('anthropic')} URL</label>
                <Input
                  value={anthropicUrl}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      endpoints: ensureEndpoint(draft.endpoints, 'anthropic', event.target.value),
                    })
                  }
                  placeholder="https://api.example.com/anthropic"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">{endpointLabel('openai_compatible')} URL</label>
                <Input
                  value={openaiUrl}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      endpoints: ensureEndpoint(
                        draft.endpoints,
                        'openai_compatible',
                        event.target.value,
                      ),
                    })
                  }
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={Boolean(
                    draft.endpoints.find((item) => item.protocol === 'openai_compatible')
                      ?.codex_needs_proxy,
                  )}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      endpoints: draft.endpoints.map((endpoint) =>
                        endpoint.protocol === 'openai_compatible'
                          ? { ...endpoint, codex_needs_proxy: event.target.checked }
                          : endpoint,
                      ),
                    });
                  }}
                />
                Codex 需要兼容代理（codex_needs_proxy）
              </label>
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">模型列表（每行一个 model id）</label>
              <textarea
                className="min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={modelsText}
                onChange={(event) => {
                  const models: ProviderModel[] = event.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((id) => ({ id, name: id }));
                  const default_model =
                    models.some((model) => model.id === draft.default_model)
                      ? draft.default_model
                      : models[0]?.id ?? '';
                  setDraft({ ...draft, models, default_model });
                }}
              />
              <div className="grid gap-2">
                <label className="text-sm font-medium">默认模型</label>
                <select
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={draft.default_model}
                  onChange={(event) => setDraft({ ...draft, default_model: event.target.value })}
                >
                  {draft.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <div>Claude Code：{isProviderUsable(draft, 'claude_code') ? '可用' : providerUnusableReason(draft, 'claude_code')}</div>
              <div>Codex：{isProviderUsable(draft, 'codex') ? '可用' : providerUnusableReason(draft, 'codex')}</div>
              <div>OpenCode：{isProviderUsable(draft, 'opencode') ? '可用' : providerUnusableReason(draft, 'opencode')}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleSave()} disabled={saving}>
                保存
              </Button>
              <Button
                variant="secondary"
                disabled={!providers.some((item) => item.id === draft.id)}
                onClick={() => void setActiveProvider(draft.id).then(() => toast.success('已设为 Active Provider')).catch((error) => toast.error(String(error)))}
              >
                设为当前供应商
              </Button>
              <Button
                variant="outline"
                disabled={!providers.some((item) => item.id === draft.id)}
                onClick={() =>
                  void testModelProvider(draft.id)
                    .then((message) => toast.success(message))
                    .catch((error) => toast.error(String(error)))
                }
              >
                测试连接
              </Button>
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={!providers.some((item) => item.id === draft.id)}
                onClick={() => void handleDelete()}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
