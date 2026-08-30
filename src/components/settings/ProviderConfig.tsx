import { useEffect, useMemo, useRef, useState } from 'react';
import { Ear, Eye, EyeOff, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Search, Settings2, Trash2, Video } from 'lucide-react';
import { toast } from 'sonner';

import { AddProviderDialog } from '@/components/settings/AddProviderDialog';
import {
  ProviderBrandIcon,
  providerDisplayName,
} from '@/components/settings/ProviderBrandIcon';
import {
  ProviderModelsPicker,
  type PickerModel,
} from '@/components/settings/ProviderModelsPicker';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  INPUT_MODALITY_OPTIONS,
  hasInputModality,
  normalizeInputModalities,
  toggleOptionalInputModality,
} from '@/lib/inputModalities';
import { enrichFetchedModels, resolveModelDisplayName } from '@/lib/providerModels';
import { configApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  BuiltinProviderTemplate,
  ModelProvider,
  Protocol,
  ProtocolEndpoint,
  ProviderModel,
} from '@/types/provider';

type CatalogSelection =
  | { kind: 'provider'; id: string }
  | { kind: 'template'; id: string }
  | { kind: 'draft'; id: string };

const API_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  mimo: 'https://mimo.mi.com/',
  moonshot: 'https://platform.kimi.com/console/api-keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys',
  'opencode-go': 'https://opencode.ai/auth',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  zhipu: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
};

export function resolveProviderApiKeyUrl(templateId?: string | null): string | null {
  return templateId ? API_KEY_URLS[templateId] ?? null : null;
}

type CatalogRow =
  | {
      key: string;
      kind: 'provider';
      provider: ModelProvider;
      templateId: string | null;
      name: string;
      enabled: boolean;
      active: boolean;
    }
  | {
      key: string;
      kind: 'template';
      template: BuiltinProviderTemplate;
      templateId: string;
      name: string;
      enabled: boolean;
      active: boolean;
    };

function providerFromTemplate(template: BuiltinProviderTemplate): ModelProvider {
  return {
    id: crypto.randomUUID(),
    name: providerDisplayName(template.name, template.id),
    enabled: false,
    api_key: '',
    endpoints: structuredClone(template.endpoints),
    models: [],
    default_model: '',
    builtin_template_id: template.id,
    opencode_provider_key: template.opencode_provider_key ?? null,
    opencode_npm: template.opencode_npm ?? null,
  };
}

/** Keep runtime default_model as first configured model (no UI selector). */
function syncDefaultModel(models: ProviderModel[], currentDefault = ''): string {
  const ids = models.map((model) => model.id.trim()).filter(Boolean);
  if (ids.some((id) => id === currentDefault.trim())) return currentDefault.trim();
  return ids[0] ?? '';
}

const DEFAULT_OPENAI_MODEL_LIMITS = {
  context_window: 200_000,
  max_output_tokens: 65_536,
} as const;

function hasOpenAiEndpoint(provider: ModelProvider): boolean {
  return provider.endpoints.some(
    (endpoint) => endpoint.protocol === 'openai_compatible' && endpoint.base_url.trim().length > 0,
  );
}

function withDefaultOpenAiModelLimits(
  model: ProviderModel,
  applyDefaults: boolean,
): ProviderModel {
  if (!applyDefaults) return model;
  return {
    ...model,
    context_window: model.context_window ?? DEFAULT_OPENAI_MODEL_LIMITS.context_window,
    max_output_tokens: model.max_output_tokens ?? DEFAULT_OPENAI_MODEL_LIMITS.max_output_tokens,
  };
}

function cleanProviderModel(
  model: ProviderModel,
  providerTemplateId?: string | null,
): ProviderModel | null {
  const id = model.id.trim();
  if (!id) return null;
  const cleaned: ProviderModel = {
    id,
    name: resolveModelDisplayName({
      id,
      name: model.name,
      providerTemplateId,
    }),
  };
  if (model.context_1m === true) {
    cleaned.context_1m = true;
  }
  if (typeof model.context_window === 'number' && Number.isFinite(model.context_window) && model.context_window > 0) {
    cleaned.context_window = Math.floor(model.context_window);
  }
  if (
    typeof model.max_input_tokens === 'number'
    && Number.isFinite(model.max_input_tokens)
    && model.max_input_tokens > 0
  ) {
    cleaned.max_input_tokens = Math.floor(model.max_input_tokens);
  }
  if (
    typeof model.max_output_tokens === 'number'
    && Number.isFinite(model.max_output_tokens)
    && model.max_output_tokens > 0
  ) {
    cleaned.max_output_tokens = Math.floor(model.max_output_tokens);
  }
  if (model.input_modalities?.length) {
    cleaned.input_modalities = normalizeInputModalities(model.input_modalities);
  }
  return cleaned;
}

function parseOptionalPositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function builtinCatalogModels(template: BuiltinProviderTemplate | undefined): PickerModel[] {
  if (!template) return [];
  return template.models.map((model) => ({
    id: model.id,
    name: resolveModelDisplayName({
      id: model.id,
      name: model.name,
      providerTemplateId: template.id,
    }),
    input_modalities: model.input_modalities ?? null,
  }));
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
      codex_needs_proxy:
        protocol === 'openai_compatible' ? true : protocol === 'openai_responses' ? false : null,
    },
  ];
}

function setCodexNeedsProxy(endpoints: ProtocolEndpoint[], enabled: boolean): ProtocolEndpoint[] {
  const hasOpenAi = endpoints.some((item) => item.protocol === 'openai_compatible');
  if (!hasOpenAi) {
    return [
      ...endpoints,
      {
        protocol: 'openai_compatible',
        base_url: '',
        api_key_override: null,
        codex_needs_proxy: enabled,
      },
    ];
  }
  return endpoints.map((endpoint) =>
    endpoint.protocol === 'openai_compatible'
      ? { ...endpoint, codex_needs_proxy: enabled }
      : endpoint,
  );
}

function catalogSortRank(row: CatalogRow): number {
  // Only enabled providers float to the top; new/disabled stay in list order (customs last).
  return row.kind === 'provider' && row.provider.enabled ? 0 : 1;
}

function updateModelAt(
  models: ProviderModel[],
  index: number,
  patch: Partial<ProviderModel>,
): ProviderModel[] {
  return models.map((model, i) => (i === index ? { ...model, ...patch } : model));
}

export function ProviderConfigPanel() {
  const {
    config,
    fetchConfig,
    upsertModelProvider,
    deleteModelProvider,
    setModelProviderEnabled,
    testModelProvider,
  } = useSettingsStore();

  const providers = config?.model_providers ?? [];
  const activeId = config?.active_provider_id ?? null;
  const [selection, setSelection] = useState<CatalogSelection | null>(null);
  const [draft, setDraft] = useState<ModelProvider | null>(null);
  const [templates, setTemplates] = useState<BuiltinProviderTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSource, setPickerSource] = useState<'api' | 'builtin' | 'empty'>('empty');
  const [pickerCatalog, setPickerCatalog] = useState<PickerModel[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const draftRef = useRef<ModelProvider | null>(null);
  draftRef.current = draft;
  const isBuiltin = Boolean(draft?.builtin_template_id);

  useEffect(() => {
    void fetchConfig();
    void configApi.listBuiltinProviderTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [fetchConfig]);

  const catalog = useMemo(() => {
    const rows: CatalogRow[] = [];
    const usedProviderIds = new Set<string>();

    for (const template of templates) {
      const instance = providers.find((provider) => provider.builtin_template_id === template.id);
      if (instance) {
        usedProviderIds.add(instance.id);
        rows.push({
          key: `provider:${instance.id}`,
          kind: 'provider',
          provider: instance,
          templateId: template.id,
          name: providerDisplayName(instance.name, template.id),
          enabled: instance.enabled,
          active: instance.id === activeId,
        });
      } else {
        rows.push({
          key: `template:${template.id}`,
          kind: 'template',
          template,
          templateId: template.id,
          name: providerDisplayName(template.name, template.id),
          enabled: false,
          active: false,
        });
      }
    }

    for (const provider of providers) {
      if (usedProviderIds.has(provider.id)) continue;
      rows.push({
        key: `provider:${provider.id}`,
        kind: 'provider',
        provider,
        templateId: provider.builtin_template_id ?? null,
        name: providerDisplayName(provider.name, provider.builtin_template_id),
        enabled: provider.enabled,
        active: provider.id === activeId,
      });
    }

    rows.sort((a, b) => catalogSortRank(a) - catalogSortRank(b));
    return rows;
  }, [templates, providers, activeId]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((row) => row.name.toLowerCase().includes(q));
  }, [catalog, search]);

  useEffect(() => {
    if (selection) return;
    const first = catalog[0];
    if (!first) return;
    setShowApiKey(false);
    if (first.kind === 'provider') {
      setSelection({ kind: 'provider', id: first.provider.id });
    } else {
      setSelection({ kind: 'template', id: first.template.id });
    }
  }, [catalog, selection]);

  useEffect(() => {
    setShowApiKey(false);
    setEditingModelIndex(null);
  }, [selection?.kind, selection && 'id' in selection ? selection.id : null]);

  useEffect(() => {
    if (editingModelIndex == null || !draft) return;
    if (editingModelIndex < 0 || editingModelIndex >= draft.models.length) {
      setEditingModelIndex(null);
    }
  }, [draft, editingModelIndex]);

  useEffect(() => {
    if (!selection) {
      setDraft(null);
      return;
    }
    if (selection.kind === 'draft') {
      return;
    }
    if (selection.kind === 'provider') {
      const selected = providers.find((provider) => provider.id === selection.id) ?? null;
      setDraft(selected ? structuredClone(selected) : null);
      return;
    }
    const instance = providers.find((provider) => provider.builtin_template_id === selection.id);
    if (instance) {
      setSelection({ kind: 'provider', id: instance.id });
      return;
    }
    const template = templates.find((item) => item.id === selection.id);
    if (!template) {
      setDraft(null);
      return;
    }
    setDraft((current) => {
      if (
        current?.builtin_template_id === template.id &&
        !providers.some((provider) => provider.id === current.id)
      ) {
        return current;
      }
      return providerFromTemplate(template);
    });
  }, [selection, providers, templates]);

  const anthropicUrl =
    draft?.endpoints.find((endpoint) => endpoint.protocol === 'anthropic')?.base_url ?? '';
  const openaiUrl =
    draft?.endpoints.find((endpoint) => endpoint.protocol === 'openai_compatible')?.base_url ?? '';
  const responsesUrl =
    draft?.endpoints.find((endpoint) => endpoint.protocol === 'openai_responses')?.base_url ?? '';
  const showClaudeContext1m = anthropicUrl.trim().length > 0;
  const showOpenAiModelLimits = openaiUrl.trim().length > 0 || responsesUrl.trim().length > 0;
  const showModelMoreSettings = showClaudeContext1m || showOpenAiModelLimits;
  const editingModel =
    draft && editingModelIndex != null ? draft.models[editingModelIndex] ?? null : null;
  const persisted = Boolean(draft && providers.some((item) => item.id === draft.id));
  const draftTemplateId = draft?.builtin_template_id ?? null;
  const apiKeyUrl = resolveProviderApiKeyUrl(draftTemplateId);
  const codexNeedsProxy = Boolean(
    draft?.endpoints.find((item) => item.protocol === 'openai_compatible')?.codex_needs_proxy,
  );
  const canTestConnection = Boolean(
    draft && draft.api_key.trim() && resolveFetchBaseUrl(draft),
  );

  async function handleSave() {
    if (!draft) return;
    const cleaned: ModelProvider = {
      ...draft,
      name: draft.name.trim() || providerDisplayName(draft.name, draft.builtin_template_id),
      api_key: draft.api_key.trim(),
      endpoints: draft.endpoints.filter((endpoint) => endpoint.base_url.trim().length > 0),
      models: draft.models
        .map((model) => cleanProviderModel(model, draft.builtin_template_id))
        .filter((model): model is ProviderModel => Boolean(model)),
    };
    if (!cleaned.name.trim()) {
      toast.error('请填写供应商名称');
      return;
    }
    if (cleaned.endpoints.length === 0) {
      toast.error('至少填写一个协议端点 URL');
      return;
    }
    cleaned.default_model = syncDefaultModel(cleaned.models, cleaned.default_model);
    // Enabling requires a key; keep enabled=false when saving without one.
    if (cleaned.enabled && !cleaned.api_key) {
      cleaned.enabled = false;
    }
    setSaving(true);
    try {
      await upsertModelProvider(cleaned);
      toast.success('供应商已保存');
      setSelection({ kind: 'provider', id: cleaned.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleEnabledChange(enabled: boolean) {
    if (!draft) return;
    if (enabled) {
      if (!draft.api_key.trim()) {
        toast.error('启用前请先填写 API Key');
        return;
      }
      if (!draft.endpoints.some((endpoint) => endpoint.base_url.trim().length > 0)) {
        toast.error('启用前请至少填写一个协议端点');
        return;
      }
      if (!draft.models.some((model) => model.id.trim().length > 0)) {
        toast.error('启用前请至少添加一个模型');
        return;
      }
      if (!persisted) {
        toast.error('请先保存供应商后再启用');
        return;
      }
    }
    const previous = draft.enabled;
    setDraft({ ...draft, enabled });
    try {
      await setModelProviderEnabled(draft.id, enabled);
    } catch (error) {
      setDraft({ ...draft, enabled: previous });
      toast.error(String(error));
    }
  }

  async function handleAddCustomProvider(provider: ModelProvider) {
    await upsertModelProvider(provider);
    setSelection({ kind: 'provider', id: provider.id });
    toast.success('已添加供应商（默认未启用）');
  }

  function handleSelectRow(row: CatalogRow) {
    setShowApiKey(false);
    if (row.kind === 'provider') {
      setSelection({ kind: 'provider', id: row.provider.id });
      return;
    }
    setSelection({ kind: 'template', id: row.template.id });
  }

  async function handleDelete() {
    if (!draft || !persisted || isBuiltin) return;
    try {
      await deleteModelProvider(draft.id);
      setSelection(null);
      setDeleteConfirmOpen(false);
      toast.success('已删除');
    } catch (error) {
      toast.error(String(error));
    }
  }

  function openRenameDialog() {
    if (!draft || isBuiltin) return;
    setRenameValue(draft.name);
    setRenameOpen(true);
  }

  async function handleRenameSave() {
    if (!draft || isBuiltin) return;
    const name = renameValue.trim();
    if (!name) {
      toast.error('请填写提供商名称');
      return;
    }
    const next = { ...draft, name };
    setDraft(next);
    if (!persisted) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await upsertModelProvider(next);
      setRenameOpen(false);
      toast.success('名称已更新');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRenaming(false);
    }
  }

  function addModelRow() {
    if (!draft) return;
    const models = [
      ...draft.models,
      withDefaultOpenAiModelLimits({ id: '', name: '' }, hasOpenAiEndpoint(draft)),
    ];
    setDraft({
      ...draft,
      models,
      default_model: syncDefaultModel(models, draft.default_model),
    });
  }

  function removeModelRow(index: number) {
    if (!draft) return;
    const models = draft.models.filter((_, i) => i !== index);
    setDraft({
      ...draft,
      models,
      default_model: syncDefaultModel(models, draft.default_model),
    });
    setEditingModelIndex((current) => {
      if (current == null) return current;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  }

  function applySelectedModels(models: ProviderModel[]) {
    setDraft((prev) => {
      if (!prev) return prev;
      const existingIds = new Set(prev.models.map((model) => model.id.trim()).filter(Boolean));
      const nextModels = models.map((model) => (
        existingIds.has(model.id.trim())
          ? model
          : withDefaultOpenAiModelLimits(model, hasOpenAiEndpoint(prev))
      ));
      return {
        ...prev,
        models: nextModels,
        default_model: syncDefaultModel(nextModels, prev.default_model),
      };
    });
  }

  function resolveFetchBaseUrl(provider: ModelProvider): string {
    const openai = provider.endpoints.find(
      (endpoint) =>
        endpoint.protocol === 'openai_compatible' && endpoint.base_url.trim().length > 0,
    )?.base_url;
    if (openai) return openai.trim();
    const responses = provider.endpoints.find(
      (endpoint) => endpoint.protocol === 'openai_responses' && endpoint.base_url.trim().length > 0,
    )?.base_url;
    if (responses) return responses.trim();
    return (
      provider.endpoints.find(
        (endpoint) => endpoint.protocol === 'anthropic' && endpoint.base_url.trim().length > 0,
      )?.base_url.trim() ?? ''
    );
  }

  async function handleTestConnection() {
    const current = draftRef.current;
    if (!current) return;
    const apiKey = current.api_key.trim();
    const baseUrl = resolveFetchBaseUrl(current);
    if (!apiKey || !baseUrl) {
      toast.error('请同时填写 API 密钥和 API 地址后再测试');
      return;
    }
    setTesting(true);
    try {
      const message = await testModelProvider(apiKey, baseUrl);
      toast.success(message);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTesting(false);
    }
  }

  async function handleOpenModelPicker() {
    const current = draftRef.current;
    if (!current) return;
    const template = templates.find((item) => item.id === current.builtin_template_id);
    const builtinModels = builtinCatalogModels(template);

    setPickerOpen(true);
    setPickerLoading(true);
    setPickerCatalog([]);
    setPickerSource('empty');

    const apiKey = current.api_key.trim();
    const baseUrl = resolveFetchBaseUrl(current);

    if (!apiKey || !baseUrl) {
      setPickerCatalog(builtinModels);
      setPickerSource(builtinModels.length > 0 ? 'builtin' : 'empty');
      setPickerLoading(false);
      if (builtinModels.length > 0) {
        toast.info('未填写密钥或地址，已展示系统内置模型');
      } else {
        toast.error('请先填写 API 密钥和 API 地址');
      }
      return;
    }

    try {
      const fetched = await configApi.fetchProviderModels(apiKey, baseUrl);
      const catalog = enrichFetchedModels(
        current.builtin_template_id,
        fetched.map((item) => ({ id: item.id, name: item.name })),
      );
      if (catalog.length > 0) {
        setPickerCatalog(catalog);
        setPickerSource('api');
        return;
      }
      setPickerCatalog(builtinModels);
      setPickerSource(builtinModels.length > 0 ? 'builtin' : 'empty');
      if (builtinModels.length > 0) {
        toast.info('接口未返回模型，已展示系统内置模型');
      } else {
        toast.error('未获取到模型');
      }
    } catch (error) {
      setPickerCatalog(builtinModels);
      setPickerSource(builtinModels.length > 0 ? 'builtin' : 'empty');
      if (builtinModels.length > 0) {
        toast.info(`获取失败，已展示系统内置模型（${String(error)}）`);
      } else {
        toast.error(String(error));
      }
    } finally {
      setPickerLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 gap-0">
      <div className="flex w-60 shrink-0 flex-col border-r border-border/60">
        <div className="px-3 pb-2 pt-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索模型平台..."
              className="h-9 pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="space-y-0.5">
            {filteredCatalog.map((row) => {
              const selected =
                (selection?.kind === 'provider' &&
                  row.kind === 'provider' &&
                  selection.id === row.provider.id) ||
                (selection?.kind === 'template' &&
                  row.kind === 'template' &&
                  selection.id === row.template.id);
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => handleSelectRow(row)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    selected
                      ? 'bg-muted/80 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <ProviderBrandIcon templateId={row.templateId} name={row.name} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {row.name}
                  </span>
                  {row.enabled && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="已启用" />
                  )}
                </button>
              );
            })}
            {filteredCatalog.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                无匹配的模型平台
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border">
              <Plus className="h-4 w-4" />
            </span>
            添加服务商
          </button>
        </div>
      </div>

      <AddProviderDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSubmit={handleAddCustomProvider}
      />

      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-2">
        {!draft ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            从左侧选择模型平台
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-8">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <ProviderBrandIcon
                  templateId={draftTemplateId}
                  name={providerDisplayName(draft.name, draftTemplateId)}
                  className="h-9 w-9"
                  size={24}
                />
                <div>
                  <div className="flex items-center gap-1.5">
                    <h2 className="text-lg font-semibold">
                      {providerDisplayName(draft.name, draftTemplateId)}
                    </h2>
                    {!isBuiltin && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        aria-label="编辑名称"
                        onClick={openRenameDialog}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <Switch
                id="provider-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => void handleEnabledChange(enabled)}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">API 密钥</label>
                {apiKeyUrl && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80 hover:underline"
                    onClick={() => {
                      void import('@tauri-apps/plugin-shell')
                        .then(({ open }) => open(apiKeyUrl))
                        .catch(() => {});
                    }}
                  >
                    获取密钥
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={draft.api_key}
                  onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                  placeholder="保存可留空，启用时必填"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 text-muted-foreground"
                  onClick={() => setShowApiKey((value) => !value)}
                  aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">API 地址</label>
                <span className="text-xs text-muted-foreground">
                  可同时配置 Anthropic / OpenAI 兼容 / OpenAI Responses 端点
                </span>
              </div>
              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">Anthropic</label>
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
                <label className="text-xs font-medium text-muted-foreground">OpenAI 兼容</label>
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
              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  OpenAI Responses
                </label>
                <Input
                  value={responsesUrl}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      endpoints: ensureEndpoint(
                        draft.endpoints,
                        'openai_responses',
                        event.target.value,
                      ),
                    })
                  }
                  placeholder="https://api.example.com/v1"
                />
                <span className="text-xs text-muted-foreground">
                  Codex 直连 Responses 接口（如智谱 /api/v1）；配置后 Codex 不再使用兼容代理
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Codex 需要兼容代理</div>
                  <div className="text-xs text-muted-foreground">
                    仅对 OpenAI 兼容端点生效；已配置 Responses 端点时 Codex 优先直连
                  </div>
                </div>
                <Switch
                  checked={codexNeedsProxy}
                  onCheckedChange={(enabled) =>
                    setDraft({
                      ...draft,
                      endpoints: setCodexNeedsProxy(draft.endpoints, enabled),
                    })
                  }
                />
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">模型</label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleOpenModelPicker()}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    获取模型列表
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={addModelRow}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    添加模型
                  </Button>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-border/60">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">模型 ID</th>
                      <th className="px-3 py-2 font-medium">显示名称</th>
                      <th className="w-20 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.models.map((model, index) => (
                      <tr key={`${index}-${model.id}`} className="border-t border-border/50">
                        <td className="px-2 py-1.5">
                          <Input
                            value={model.id}
                            className="h-8"
                            placeholder="model-id"
                            onChange={(event) => {
                              const models = updateModelAt(draft.models, index, {
                                id: event.target.value,
                              });
                              setDraft({
                                ...draft,
                                models,
                                default_model: syncDefaultModel(models, draft.default_model),
                              });
                            }}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={model.name ?? ''}
                            className="h-8"
                            placeholder="可选"
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                models: updateModelAt(draft.models, index, {
                                  name: event.target.value,
                                }),
                              })
                            }
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground"
                              aria-label={`设置模型 ${model.id || index + 1}`}
                              onClick={() => setEditingModelIndex(index)}
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                              aria-label={`删除模型 ${model.id || index + 1}`}
                              onClick={() => removeModelRow(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {draft.models.length === 0 && (
                      <tr>
                        <td
                          colSpan={3}
                          className="px-3 py-6 text-center text-xs text-muted-foreground"
                        >
                          暂无模型，可通过「获取模型列表」添加
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleSave()} disabled={saving}>
                保存
              </Button>
              <Button
                variant="outline"
                disabled={!canTestConnection || testing}
                onClick={() => void handleTestConnection()}
              >
                {testing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    测试中
                  </>
                ) : (
                  '测试连接'
                )}
              </Button>
              {!isBuiltin && (
                <Button
                  variant="ghost"
                  className="text-destructive"
                  disabled={!persisted}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="删除供应商"
        description={`确认删除供应商「${draft?.name ?? ''}」？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
      />

      <Dialog
        open={editingModelIndex != null && Boolean(editingModel)}
        onOpenChange={(open) => {
          if (!open) setEditingModelIndex(null);
        }}
      >
        <DialogContent
          overlayClassName="z-[240]"
          className={cn(
            'fixed inset-y-0 right-0 left-auto top-0 z-[240] flex h-full w-full max-w-md translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l border-r-0 p-0 shadow-xl sm:max-w-md',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
            'data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
          )}
        >
          <DialogHeader className="space-y-0 border-b border-border/60 px-4 py-3 text-left">
            <DialogTitle className="text-base">编辑模型</DialogTitle>
          </DialogHeader>
          {editingModel && editingModelIndex != null && draft && (
            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium">模型 ID</label>
                <Input value={editingModel.id} readOnly className="h-9 bg-muted/40" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="edit-model-name">
                  模型名称
                </label>
                <Input
                  id="edit-model-name"
                  className="h-9"
                  value={editingModel.name ?? ''}
                  placeholder="可选"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      models: updateModelAt(draft.models, editingModelIndex, {
                        name: event.target.value,
                      }),
                    })
                  }
                />
              </div>

              <div className="space-y-3 border-t border-border/60 pt-4">
                <p className="text-sm font-medium">输入模态</p>
                <div className="flex flex-wrap gap-2">
                  {INPUT_MODALITY_OPTIONS.map(({ id, label }) => {
                    const selected = hasInputModality(editingModel.input_modalities, id);
                    const Icon = id === 'image' ? Eye : id === 'audio' ? Ear : Video;
                    return (
                      <Button
                        key={id}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            models: updateModelAt(draft.models, editingModelIndex, {
                              input_modalities: toggleOptionalInputModality(editingModel.input_modalities, id),
                            }),
                          })
                        }
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  勾选「视觉」表示模型原生支持图片识别；未勾选时，若已启用「设置 → 图片识别」，发送图片将自动走解析模型。
                </p>
              </div>

              {showModelMoreSettings && (
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <p className="text-sm font-medium">更多设置</p>
                  {showClaudeContext1m && (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm">1M 上下文</p>
                        <p className="text-xs text-muted-foreground">
                          仅 Claude Code（模型 ID 追加 [1m]）
                        </p>
                      </div>
                      <Switch
                        checked={editingModel.context_1m === true}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            models: updateModelAt(draft.models, editingModelIndex, {
                              context_1m: checked ? true : null,
                            }),
                          })
                        }
                      />
                    </div>
                  )}
                  {showOpenAiModelLimits && (
                    <div className="grid gap-3">
                      <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">上下文窗口</span>
                        <Input
                          type="number"
                          min={1}
                          className="h-9"
                          placeholder="例如 128000"
                          value={editingModel.context_window ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              models: updateModelAt(draft.models, editingModelIndex, {
                                context_window: parseOptionalPositiveInt(event.target.value),
                              }),
                            })
                          }
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">最大输入 Token</span>
                        <Input
                          type="number"
                          min={1}
                          className="h-9"
                          placeholder="例如 128000"
                          value={editingModel.max_input_tokens ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              models: updateModelAt(draft.models, editingModelIndex, {
                                max_input_tokens: parseOptionalPositiveInt(event.target.value),
                              }),
                            })
                          }
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">最大输出 Token</span>
                        <Input
                          type="number"
                          min={1}
                          className="h-9"
                          placeholder="例如 65536"
                          value={editingModel.max_output_tokens ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              models: updateModelAt(draft.models, editingModelIndex, {
                                max_output_tokens: parseOptionalPositiveInt(event.target.value),
                              }),
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent overlayClassName="z-[240]" className="z-[240] max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑提供商名称</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-1">
            <label className="text-sm font-medium" htmlFor="rename-provider-name">
              提供商名称
            </label>
            <Input
              id="rename-provider-name"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="例如 OpenAI"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleRenameSave();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={renaming}
              onClick={() => setRenameOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={renaming} onClick={() => void handleRenameSave()}>
              {renaming ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProviderModelsPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={`${providerDisplayName(draft?.name ?? '', draftTemplateId)} 模型`}
        loading={pickerLoading}
        source={pickerSource}
        catalog={pickerCatalog}
        selected={draft?.models ?? []}
        onChangeSelected={applySelectedModels}
      />
    </div>
  );
}
