import { Download, Eye, EyeOff, Loader2, Plus, Trash2, Wand, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { EditorView } from '@codemirror/view';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { extractCodexBaseUrl, extractCodexModelName, generateCodexDefaultConfigToml, setCodexBaseUrl, setCodexModelName } from '../../lib/codexTomlUtils';
import { modelsFromText, modelsToText } from '../../lib/providerModels';
import { applyClaudeFormToSettings, CLAUDE_SETTINGS_DEFAULT, parseClaudeSettingsDraft, type ClaudeRoleMapping, type ClaudeSettingsForm } from '../../lib/claudeSettingsConfig';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentProviderProfile, AgentProviderProfileUpsert, CodexCatalogModel } from '../../types/provider';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import { Switch } from '../ui/switch';

const baseTheme = EditorView.theme({
  '&': { fontSize: '13px', borderRadius: '8px', overflow: 'hidden' },
  '.cm-content': { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(99, 179, 237, 0.3) !important' },
  '.cm-content ::selection': { backgroundColor: 'rgba(99, 179, 237, 0.3) !important' },
});

type ProfileAgentKind = 'claude_code' | 'codex' | 'opencode';
type ProfileDraft = { id: string; name: string; note: string; models: string; apiKey: string; baseUrl: string; defaultModel: string; context1m: boolean; codexNeedsProxy: boolean; advancedConfig: string; authJson: string; configToml: string; modelCatalog: CodexCatalogModel[]; claudeForm: ClaudeSettingsForm };

const AGENTS: Array<{ id: ProfileAgentKind; label: string; description: string; baseUrlLabel: string; placeholder: string }> = [
  { id: 'claude_code', label: 'Claude Code', description: '写入 Claude Code 的 settings.json 配置。', baseUrlLabel: 'Anthropic Base URL', placeholder: 'https://api.anthropic.com' },
  { id: 'codex', label: 'Codex', description: '写入 Codex 的 auth.json 和 config.toml 配置。', baseUrlLabel: 'OpenAI Base URL', placeholder: 'https://api.openai.com/v1' },
  { id: 'opencode', label: 'OpenCode', description: '写入 OpenCode 的 opencode.json 配置。', baseUrlLabel: 'OpenAI 兼容 Base URL', placeholder: 'https://api.openai.com/v1' },
];

function emptyDraft(): ProfileDraft {
  const settings = structuredClone(CLAUDE_SETTINGS_DEFAULT);
  const { form } = parseClaudeSettingsDraft(JSON.stringify(settings));
  const configToml = generateCodexDefaultConfigToml();
  return { id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2), name: '', note: '', models: '', apiKey: '', baseUrl: '', defaultModel: extractCodexModelName(configToml) || 'gpt-5.6', context1m: false, codexNeedsProxy: false, advancedConfig: JSON.stringify(settings, null, 2), authJson: JSON.stringify({ OPENAI_API_KEY: '' }, null, 2), configToml, modelCatalog: [], claudeForm: form };
}

function toDraft(profile: AgentProviderProfile): ProfileDraft {
  const native = profile.native_config;
  const claudeEnv = native.type === 'claude_code' && native.settings.env && typeof native.settings.env === 'object'
    ? native.settings.env as Record<string, unknown>
    : {};
  const claudeSettings = native.type === 'claude_code' ? native.settings : CLAUDE_SETTINGS_DEFAULT;
  const parsedClaude = parseClaudeSettingsDraft(JSON.stringify(claudeSettings));
  const modelCatalog = native.type === 'codex' && native.model_catalog ? (typeof native.model_catalog === 'string' ? JSON.parse(native.model_catalog) : native.model_catalog) : [];
  const models = native.type === 'codex' && modelCatalog.length > 0
    ? modelsToText(modelCatalog.map((m: CodexCatalogModel) => m.model))
    : modelsToText(profile.models.map((model) => model.id));
  const configToml = native.type === 'codex' ? (native.config_toml ?? '') : '';
  return {
    id: profile.id, name: profile.name, note: profile.note, models,
    apiKey: native.type === 'codex' ? (native.api_key ?? '') : (typeof claudeEnv.ANTHROPIC_AUTH_TOKEN === 'string' ? claudeEnv.ANTHROPIC_AUTH_TOKEN : ''),
    baseUrl: native.type === 'claude_code' ? (typeof claudeEnv.ANTHROPIC_BASE_URL === 'string' ? claudeEnv.ANTHROPIC_BASE_URL : '') : native.openai_base_url,
    defaultModel: native.type === 'codex' ? (extractCodexModelName(configToml) || '') : '',
    context1m: false,
    codexNeedsProxy: native.type === 'codex' && Boolean(native.codex_needs_proxy),
    advancedConfig: JSON.stringify(parsedClaude.settings, null, 2),
    authJson: native.type === 'codex' ? (native.auth_json ?? '') : '',
    configToml,
    modelCatalog,
    claudeForm: parsedClaude.form,
  };
}

function profileModelsFromClaudeForm(form: ClaudeSettingsForm): string[] {
  return modelsFromText([
    form.fallbackModel,
    form.sonnet.requestModel,
    form.opus.requestModel,
    form.fable.requestModel,
    form.haiku.requestModel,
  ].join('\n'));
}

function profileToUpsert(agentKind: ProfileAgentKind, draft: ProfileDraft): AgentProviderProfileUpsert {
  const models = agentKind === 'codex' && draft.modelCatalog.length > 0
    ? draft.modelCatalog.map((m) => ({ id: m.model, name: m.displayName || m.model }))
    : modelsFromText(draft.models).map((id) => ({ id, name: id }));
  const common = { id: draft.id, agent_kind: agentKind, name: draft.name.trim(), note: draft.note.trim(), models, default_model: agentKind === 'codex' ? (draft.defaultModel.trim() || '') : '' };
  const advanced = draft.advancedConfig.trim() ? JSON.parse(draft.advancedConfig) : undefined;
  if (agentKind === 'claude_code') {
    const parsed = parseClaudeSettingsDraft(draft.advancedConfig);
    const claudeModels = profileModelsFromClaudeForm(parsed.form);
    return {
      ...common,
      models: claudeModels.map((id) => ({ id, name: id })),
      default_model: parsed.form.fallbackModel,
      native_config: { type: 'claude_code', settings: parsed.settings },
    };
  }
  if (agentKind === 'codex') return { ...common, native_config: { type: 'codex', api_key: draft.apiKey || undefined, openai_base_url: draft.baseUrl.trim(), codex_needs_proxy: draft.codexNeedsProxy, advanced_config: advanced, auth_json: draft.authJson.trim() || undefined, config_toml: draft.configToml.trim() || undefined, model_catalog: draft.modelCatalog.length > 0 ? draft.modelCatalog : undefined } };
  return { ...common, native_config: { type: 'opencode', api_key: draft.apiKey || undefined, openai_base_url: draft.baseUrl.trim(), advanced_config: advanced } };
}

function ModelDropdown({ models, onSelect }: { models: string[]; onSelect: (model: string) => void }) {
  if (models.length === 0) {
    return <div className="w-9 shrink-0" />;
  }
  return (
    <Select value="" onValueChange={onSelect}>
      <SelectTrigger className="h-9 w-9 shrink-0 justify-center px-1.5" aria-label="选择模型" />
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m} value={m}>{m}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type CodexAdvancedOptionsProps = {
  editing: ProfileDraft;
  setEditing: React.Dispatch<React.SetStateAction<ProfileDraft | null>>;
  baseUrl: string;
  apiKey: string;
};

function CodexAdvancedOptions({ editing, setEditing, baseUrl, apiKey }: CodexAdvancedOptionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);

  const handleFetchModels = useCallback(async () => {
    if (!baseUrl || !apiKey) {
      toast.error('请先填写 API Key 和 Base URL。');
      return;
    }
    setFetching(true);
    try {
      const base = baseUrl.replace(/\/$/, '');
      let res = await fetch(`${base}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${base}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const models = (data.data ?? data.models ?? []).map((m: { id: string }) => m.id).filter(Boolean) as string[];
      setFetchedModels(models);
      toast.success(`已获取 ${models.length} 个模型。`);
    } catch (e) {
      toast.error(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  }, [baseUrl, apiKey]);

  const handleAddRow = useCallback(() => {
    setEditing((prev) => prev ? { ...prev, modelCatalog: [...prev.modelCatalog, { model: '', displayName: '', contextWindow: undefined }] } : prev);
  }, [setEditing]);

  const handleUpdateRow = useCallback((index: number, patch: Partial<CodexCatalogModel>) => {
    setEditing((prev) => prev ? { ...prev, modelCatalog: prev.modelCatalog.map((row, i) => i === index ? { ...row, ...patch } : row) } : prev);
  }, [setEditing]);

  const handleRemoveRow = useCallback((index: number) => {
    setEditing((prev) => prev ? { ...prev, modelCatalog: prev.modelCatalog.filter((_, i) => i !== index) } : prev);
  }, [setEditing]);

  return (
    <div className="rounded-lg border border-border/55 bg-muted/20 p-4 space-y-4">
      <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:opacity-70">
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        高级选项
      </button>
      {expanded && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">上游格式</label>
            <Select value={editing.codexNeedsProxy ? 'chat' : 'responses'} onValueChange={(v) => setEditing((prev) => prev ? { ...prev, codexNeedsProxy: v === 'chat' } : prev)}>
              <SelectTrigger className="w-full"><span className="text-sm">{editing.codexNeedsProxy ? 'Chat Completions（需开启路由）' : 'Responses（原生）'}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="responses">Responses（原生）</SelectItem>
                <SelectItem value="chat">Chat Completions（需开启路由）</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {editing.codexNeedsProxy
                ? '供应商使用 Chat Completions 协议或非 GPT 模型时，需要通过本地兼容代理路由转换。'
                : '供应商原生为 Responses API 时选择此项，直连不转换格式。'}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground">模型映射</label>
              <div className="flex gap-1">
                <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={fetching || !baseUrl || !apiKey} className="h-7 gap-1">
                  {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  获取模型列表
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleAddRow} className="h-7 gap-1">
                  <Plus className="h-3.5 w-3.5" />添加模型
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">生成 Codex model_catalog_json，让 /model 命令显示这些第三方模型名；表中条目按填写内容原样保存。修改后需要重启 Codex 才能刷新模型列表。</p>
            {editing.modelCatalog.length > 0 && (
              <div className="space-y-2">
                <div className="hidden grid-cols-[1fr_1fr_120px_36px] gap-2 px-1 text-xs font-medium text-muted-foreground md:grid">
                  <span>菜单显示名</span><span>实际请求模型</span><span>上下文窗口</span><span />
                </div>
                {editing.modelCatalog.map((row, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_120px_36px]">
                    <Input value={row.displayName ?? ''} onChange={(e) => handleUpdateRow(index, { displayName: e.target.value })} placeholder="例如: DeepSeek V4 Flash" />
                    <div className="flex gap-1">
                      <Input value={row.model} onChange={(e) => handleUpdateRow(index, { model: e.target.value })} placeholder="例如: deepseek-v4-flash" className="flex-1" />
                      {fetchedModels.length > 0 && (
                        <Select value="" onValueChange={(v) => handleUpdateRow(index, { model: v, displayName: row.displayName?.trim() ? row.displayName : v })}>
                          <SelectTrigger className="h-9 w-9 shrink-0 justify-center px-1.5" aria-label="选择模型" />
                          <SelectContent>
                            {fetchedModels.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <Input type="number" min={1} inputMode="numeric" value={row.contextWindow ?? ''} onChange={(e) => handleUpdateRow(index, { contextWindow: e.target.value.replace(/[^\d]/g, '') ? Number(e.target.value.replace(/[^\d]/g, '')) : undefined })} placeholder="例如: 128000" />
                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveRow(index)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type ClaudeAdvancedOptionsProps = {
  editing: ProfileDraft;
  updateClaudeForm: (form: ClaudeSettingsForm) => void;
  fetchedModels: string[];
  fetchingModels: boolean;
  fetchModels: () => void;
};

function ClaudeAdvancedOptions({ editing, updateClaudeForm, fetchedModels, fetchingModels, fetchModels }: ClaudeAdvancedOptionsProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/55 bg-muted/20 p-4 space-y-4">
      <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:opacity-70">
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        高级选项
      </button>
      {expanded && (
        <div className="space-y-4">
          <div className="space-y-3 border-b border-border/55 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold">模型映射</h4>
                <p className="mt-1 text-xs text-foreground/55">显示名称只影响 /model 菜单；1M 只是给 Claude Code 的上下文能力声明。</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={fetchModels} disabled={fetchingModels || !editing.claudeForm.apiKey}>
                {fetchingModels ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
                获取模型列表
              </Button>
            </div>
            <div className={`grid gap-2 text-xs text-foreground ${fetchedModels.length > 0 ? 'grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_40px_92px]' : 'grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_92px]'}`}>
              <span>模型角色</span>
              <span>显示名称</span>
              <span>实际请求模型</span>
              {fetchedModels.length > 0 && <span />}
              <span>声明支持 1M</span>
              {(['sonnet', 'opus', 'fable', 'haiku'] as const).map((role) => {
                const roleLabel = role === 'sonnet' ? 'Sonnet' : role === 'opus' ? 'Opus' : role === 'fable' ? 'Fable' : 'Haiku';
                const isHaiku = role === 'haiku';
                const form = isHaiku
                  ? editing.claudeForm.haiku
                  : editing.claudeForm[role];
                const handleModelSelect = (model: string) => {
                  if (isHaiku) {
                    updateClaudeForm({ ...editing.claudeForm, haiku: { ...editing.claudeForm.haiku, displayName: model, requestModel: model } });
                  } else {
                    const patch = { displayName: model, requestModel: model } as Partial<typeof form>;
                    updateClaudeForm({ ...editing.claudeForm, [role]: { ...form, ...patch } });
                  }
                };
                return (
                  <>
                    <span className="self-center text-sm text-foreground">{roleLabel}</span>
                    {isHaiku ? (
                      <Input aria-label={`${roleLabel} 显示名称`} value={editing.claudeForm.haiku.displayName} onChange={(e) => updateClaudeForm({ ...editing.claudeForm, haiku: { ...editing.claudeForm.haiku, displayName: e.target.value } })} />
                    ) : (
                      <Input aria-label={`${roleLabel} 显示名称`} value={form.displayName} onChange={(e) => updateClaudeForm({ ...editing.claudeForm, [role]: { ...form, displayName: e.target.value } })} />
                    )}
                    {isHaiku ? (
                      <Input aria-label={`${roleLabel} 实际请求模型`} value={editing.claudeForm.haiku.requestModel} onChange={(e) => updateClaudeForm({ ...editing.claudeForm, haiku: { ...editing.claudeForm.haiku, requestModel: e.target.value } })} />
                    ) : (
                      <Input aria-label={`${roleLabel} 实际请求模型`} value={form.requestModel} onChange={(e) => updateClaudeForm({ ...editing.claudeForm, [role]: { ...form, requestModel: e.target.value } })} />
                    )}
                    {fetchedModels.length > 0 && <ModelDropdown models={fetchedModels} onSelect={handleModelSelect} />}
                    {!isHaiku && (
                      <label className="flex items-center gap-2">
                        <Switch checked={(form as ClaudeRoleMapping).supports1m} onCheckedChange={(c) => updateClaudeForm({ ...editing.claudeForm, [role]: { ...form, supports1m: c } } as typeof editing.claudeForm)} />
                        1M
                      </label>
                    )}
                  </>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className={`grid gap-2 text-xs text-foreground items-center ${fetchedModels.length > 0 ? 'grid-cols-[90px_minmax(0,1fr)_40px_92px]' : 'grid-cols-[90px_minmax(0,1fr)_92px]'}`}>
              <span>默认兜底模型</span>
              <Input
                aria-label="默认兜底模型"
                value={editing.claudeForm.fallbackModel}
                onChange={(e) => updateClaudeForm({ ...editing.claudeForm, fallbackModel: e.target.value })}
              />
              {fetchedModels.length > 0 && (
                <ModelDropdown
                  models={fetchedModels}
                  onSelect={(model) => updateClaudeForm({ ...editing.claudeForm, fallbackModel: model })}
                />
              )}
              <label className="flex items-center gap-2">
                <Switch checked={editing.claudeForm.fallbackSupports1m ?? false} onCheckedChange={(c) => updateClaudeForm({ ...editing.claudeForm, fallbackSupports1m: c })} />
                1M
              </label>
            </div>
            <p className="text-xs text-foreground/55">用于未明确落到 Sonnet、Opus、Fable、Haiku 角色的请求。</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProviderConfigPanel() {
  const { config, upsertAgentProfile, activateAgentProfile, activateDefaultClaudeSupplier, activateDefaultCodexSupplier, deleteAgentProfile, testAgentProfile } = useSettingsStore();
  const [agentKind, setAgentKind] = useState<ProfileAgentKind>('claude_code');
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jsonError, setJsonError] = useState('');
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const profiles = useMemo(() => (config?.agent_profile_registry?.profiles ?? []).filter((profile) => profile.agent_kind === agentKind), [agentKind, config?.agent_profile_registry?.profiles]);
  const activeId = config?.agent_profile_registry?.active_profile_ids?.[agentKind] ?? null;
  const agent = AGENTS.find((item) => item.id === agentKind)!;

  const isUpdatingBaseUrlRef = useRef(false);
  const isUpdatingModelNameRef = useRef(false);

  // API Key → auth.json sync
  const handleCodexApiKeyChange = useCallback((key: string) => {
    if (!editing) return;
    const trimmed = key.trim();
    try {
      const auth = JSON.parse(editing.authJson || '{}');
      auth.OPENAI_API_KEY = trimmed;
      setEditing({ ...editing, apiKey: trimmed, authJson: JSON.stringify(auth, null, 2) });
    } catch {
      setEditing({ ...editing, apiKey: trimmed });
    }
  }, [editing, setEditing]);

  // Base URL → config.toml sync
  const handleCodexBaseUrlChange = useCallback((url: string) => {
    if (!editing) return;
    const sanitized = url.trim();
    isUpdatingBaseUrlRef.current = true;
    setEditing({ ...editing, baseUrl: sanitized, configToml: setCodexBaseUrl(editing.configToml, sanitized) });
    setTimeout(() => { isUpdatingBaseUrlRef.current = false; }, 0);
  }, [editing, setEditing]);

  // Default model → config.toml sync
  const handleCodexDefaultModelChange = useCallback((model: string) => {
    if (!editing) return;
    const sanitized = model.trim();
    isUpdatingModelNameRef.current = true;
    setEditing({ ...editing, defaultModel: sanitized, configToml: setCodexModelName(editing.configToml, sanitized) });
    setTimeout(() => { isUpdatingModelNameRef.current = false; }, 0);
  }, [editing, setEditing]);

  // Fetch models for Codex default model dropdown
  const fetchCodexModels = useCallback(async () => {
    if (!editing) return;
    if (!editing.baseUrl.trim() || !editing.apiKey.trim()) {
      toast.error('请先填写 API Key 和 Base URL。');
      return;
    }
    setFetchingModels(true);
    try {
      const base = editing.baseUrl.replace(/\/$/, '');
      let res = await fetch(`${base}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${editing.apiKey}` },
      });
      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${base}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${editing.apiKey}` },
        });
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const models = (data.data ?? data.models ?? []).map((m: { id: string }) => m.id).filter(Boolean) as string[];
      setFetchedModels(models);
      toast.success(`已获取 ${models.length} 个模型。`);
    } catch (e) {
      toast.error(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetchingModels(false);
    }
  }, [editing]);

  // config.toml editor change → extract Base URL and model name back to form
  const handleCodexConfigTomlChange = useCallback((value: string) => {
    if (!editing) return;
    setEditing({ ...editing, configToml: value });
    if (!isUpdatingBaseUrlRef.current) {
      const extracted = extractCodexBaseUrl(value) || '';
      if (extracted !== editing.baseUrl) {
        setEditing((prev) => prev ? { ...prev, baseUrl: extracted } : prev);
      }
    }
    if (!isUpdatingModelNameRef.current) {
      const extractedModel = extractCodexModelName(value) || '';
      if (extractedModel !== editing.defaultModel) {
        setEditing((prev) => prev ? { ...prev, defaultModel: extractedModel } : prev);
      }
    }
  }, [editing, setEditing]);

  // On load: extract Base URL from config.toml if editing an existing profile
  useEffect(() => {
    if (!editing || agentKind !== 'codex') return;
    const extracted = extractCodexBaseUrl(editing.configToml);
    if (extracted && extracted !== editing.baseUrl) {
      setEditing((prev) => prev ? { ...prev, baseUrl: extracted } : prev);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const updateClaudeForm = (nextForm: ClaudeSettingsForm) => {
    if (!editing) return;
    const current = parseClaudeSettingsDraft(editing.advancedConfig).settings;
    const settings = applyClaudeFormToSettings(current, nextForm);
    setEditing({
      ...editing,
      apiKey: nextForm.apiKey,
      baseUrl: nextForm.baseUrl,
      models: [nextForm.fallbackModel, nextForm.sonnet.requestModel, nextForm.opus.requestModel, nextForm.fable.requestModel, nextForm.haiku.requestModel].filter(Boolean).join('\n'),
      claudeForm: nextForm,
      advancedConfig: JSON.stringify(settings, null, 2),
    });
  };
  const formatJson = useCallback(() => {
    if (!editing) return;
    try {
      const parsed = JSON.parse(editing.advancedConfig);
      const formatted = JSON.stringify(parsed, null, 2);
      setEditing({ ...editing, advancedConfig: formatted });
      setJsonError('');
    } catch (e) {
      setJsonError(`JSON 格式错误: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [editing, setEditing]);
  const handleJsonChange = useCallback((value: string) => {
    if (!editing) return;
    try {
      const parsed = parseClaudeSettingsDraft(value);
      setEditing({ ...editing, advancedConfig: value, claudeForm: parsed.form });
      setJsonError('');
    } catch {
      setEditing({ ...editing, advancedConfig: value });
    }
  }, [editing, setEditing]);
  const fetchModels = useCallback(async () => {
    if (!editing) return;
    const baseUrl = editing.claudeForm.baseUrl || 'https://api.anthropic.com';
    const apiKey = editing.claudeForm.apiKey;
    if (!apiKey) {
      toast.error('请先填写 API Key。');
      return;
    }
    setFetchingModels(true);
    try {
      const base = baseUrl.replace(/\/$/, '');
      // Try /v1/models first (Anthropic official), then /models (common proxy pattern)
      let res = await fetch(`${base}/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${base}/models`, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const models = (data.data ?? data.models ?? []).map((m: { id: string }) => m.id).filter(Boolean) as string[];
      setFetchedModels(models);
      toast.success(`已获取 ${models.length} 个模型。`);
    } catch (e) {
      toast.error(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetchingModels(false);
    }
  }, [editing]);
  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error('请填写供应商名称。');
      return;
    }
    if (agentKind !== 'claude_code' && !editing.baseUrl.trim()) {
      toast.error('请填写 Base URL。');
      return;
    }
    try {
      profileToUpsert(agentKind, editing);
    } catch {
      toast.error(agentKind === 'claude_code' ? '配置 JSON 必须有效，且 env 必须是对象。' : '高级配置必须是有效的 JSON。');
      return;
    }
    await run(async () => { await upsertAgentProfile(profileToUpsert(agentKind, editing)); setEditing(null); }, '供应商已保存。');
  };
  const test = async (profile: AgentProviderProfile) => {
    await run(async () => { await testAgentProfile(agentKind, profile.id); }, `“${profile.name}”连接正常。`);
  };

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="智能体供应商" className="inline-flex h-11 w-full items-center justify-start gap-1 rounded-xl bg-muted/55 p-1">
        {AGENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={agentKind === item.id} onClick={() => { setAgentKind(item.id); setEditing(null); }} className={cn('rounded-lg px-4 py-2 text-sm font-medium transition-colors', agentKind === item.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{item.label}</button>)}
      </div>
      <div className="rounded-xl border border-border/50 bg-muted/25 px-4 py-3 text-sm text-foreground/65">{agent.description} 切换供应商或模型会影响之后新建或重新启动的会话，不会热更新正在运行的会话。</div>
      {editing ? (
        <div className="space-y-5 rounded-2xl border border-border/55 bg-card/35 p-5">
          <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{profiles.some((profile) => profile.id === editing.id) ? '编辑供应商' : '新建供应商'}</h3><Button variant="ghost" size="sm" onClick={() => setEditing(null)}>返回列表</Button></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-foreground">供应商名称<Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="如：Claude 官方" /></label>
            <label className="space-y-1.5 text-xs text-foreground">备注（可选）<Input value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} placeholder="此供应商的用途说明" /></label>
          </div>
          {agentKind === 'claude_code' ? <>
            <label className="block space-y-1.5 text-xs text-foreground">API Key<div className="relative"><Input aria-label="API Key" type={showKey ? 'text' : 'password'} value={editing.claudeForm.apiKey} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, apiKey: event.target.value })} className="pr-10" /><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>
            <label className="block space-y-1.5 text-xs text-foreground">Anthropic Base URL<Input value={editing.claudeForm.baseUrl} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, baseUrl: event.target.value })} placeholder="https://api.anthropic.com" /></label>
            <ClaudeAdvancedOptions editing={editing} updateClaudeForm={updateClaudeForm} fetchedModels={fetchedModels} fetchingModels={fetchingModels} fetchModels={fetchModels} />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">配置 JSON</label>
                <Button type="button" variant="ghost" size="sm" onClick={formatJson}>
                  <Wand className="h-4 w-4 mr-1" />
                  格式化
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <CodeMirror
                  value={editing.advancedConfig}
                  minHeight="120px"
                  extensions={[json(), EditorView.lineWrapping]}
                  theme={baseTheme}
                  onChange={handleJsonChange}
                />
              </div>
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          </> : agentKind === 'codex' ? <>
            <label className="block space-y-1.5 text-xs text-foreground">API Key<div className="relative"><Input aria-label="API Key" type={showKey ? 'text' : 'password'} value={editing.apiKey} onChange={(event) => handleCodexApiKeyChange(event.target.value)} placeholder="输入 API Key" className="pr-10" /><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>
            <label className="block space-y-1.5 text-xs text-foreground">{agent.baseUrlLabel}<Input value={editing.baseUrl} onChange={(event) => handleCodexBaseUrlChange(event.target.value)} placeholder={agent.placeholder} /></label>
            <label className="block space-y-1.5 text-xs text-foreground">默认模型<div className="flex gap-1"><Input value={editing.defaultModel} onChange={(event) => handleCodexDefaultModelChange(event.target.value)} placeholder="如：gpt-5.6" className="flex-1" /><Button type="button" variant="outline" size="sm" onClick={fetchCodexModels} disabled={fetchingModels || !editing.baseUrl.trim() || !editing.apiKey.trim()} className="h-9 shrink-0 gap-1">{fetchingModels ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}获取模型</Button>{fetchedModels.length > 0 && <Select value="" onValueChange={(v) => handleCodexDefaultModelChange(v)}><SelectTrigger className="h-9 w-9 shrink-0 justify-center px-1.5" aria-label="选择模型" /><SelectContent>{fetchedModels.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select>}</div></label>
            <CodexAdvancedOptions editing={editing} setEditing={setEditing} baseUrl={editing.baseUrl} apiKey={editing.apiKey} />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">auth.json (JSON) <span className="text-destructive">*</span></label>
                <Button type="button" variant="ghost" size="sm" onClick={() => { if (!editing) return; try { const formatted = JSON.stringify(JSON.parse(editing.authJson), null, 2); setEditing({ ...editing, authJson: formatted }); } catch { /* ignore */ } }}>
                  <Wand className="h-4 w-4 mr-1" />格式化
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <CodeMirror value={editing.authJson} minHeight="80px" extensions={[json(), EditorView.lineWrapping]} theme={baseTheme} onChange={(value) => setEditing({ ...editing, authJson: value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">config.toml (TOML)</label>
              <div className="rounded-lg border overflow-hidden">
                <CodeMirror value={editing.configToml} minHeight="80px" extensions={[StreamLanguage.define(toml), EditorView.lineWrapping]} theme={baseTheme} onChange={handleCodexConfigTomlChange} />
              </div>
            </div>
          </> : <>
            <label className="block space-y-1.5 text-xs text-foreground">API Key<div className="relative"><Input aria-label="API Key" type={showKey ? 'text' : 'password'} value={editing.apiKey} onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })} placeholder="输入 API Key" className="pr-10" /><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>
            <label className="block space-y-1.5 text-xs text-foreground">{agent.baseUrlLabel}<Input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} placeholder={agent.placeholder} /></label>
            <label className="block space-y-1.5 text-xs text-foreground">高级原生配置 JSON<textarea value={editing.advancedConfig} onChange={(event) => setEditing({ ...editing, advancedConfig: event.target.value })} className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring/40" /></label>
          </>}
          <div className="flex justify-end gap-2 border-t border-border/45 pt-4"><Button variant="outline" onClick={() => setEditing(null)}>取消</Button><Button disabled={busy} onClick={save}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}保存供应商</Button></div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(235px,1fr))] gap-3">
          {agentKind === 'claude_code' && <div className={cn('flex min-h-42 flex-col gap-3 rounded-xl border p-4', !activeId ? 'border-primary/45 bg-primary/5' : 'border-border/55 bg-muted/20')}><div><div className="font-medium">默认供应商</div><p className="mt-1 text-xs text-muted-foreground">直接使用 ~/.claude/settings.json</p></div>{!activeId && <span className="w-fit rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">当前使用</span>}<div className="mt-auto"><Button size="sm" variant="outline" disabled={busy || !activeId} onClick={() => run(() => activateDefaultClaudeSupplier(), '已切换到默认供应商。')}>切换</Button></div></div>}
          {agentKind === 'codex' && <div className={cn('flex min-h-42 flex-col gap-3 rounded-xl border p-4', !activeId ? 'border-primary/45 bg-primary/5' : 'border-border/55 bg-muted/20')}><div><div className="font-medium">默认供应商</div><p className="mt-1 text-xs text-muted-foreground">直接使用 ~/.codex/ 配置</p></div>{!activeId && <span className="w-fit rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">当前使用</span>}<div className="mt-auto"><Button size="sm" variant="outline" disabled={busy || !activeId} onClick={() => run(() => activateDefaultCodexSupplier(), '已切换到默认供应商。')}>切换</Button></div></div>}
          {profiles.map((profile) => { const active = profile.id === activeId; const requiresReview = Boolean(profile.native_config.requires_review); const nativeCfg = profile.native_config; const profileUrl = nativeCfg.type === 'claude_code' ? (typeof nativeCfg.settings?.env === 'object' && nativeCfg.settings.env !== null ? (nativeCfg.settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined) : nativeCfg.openai_base_url; return <div key={profile.id} className={cn('flex min-h-42 flex-col gap-3 rounded-xl border p-4', active ? 'border-primary/45 bg-primary/5' : 'border-border/55 bg-muted/20')}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate font-medium">{profile.name}</div><div className="mt-1 truncate font-mono text-xs text-muted-foreground">{(typeof profileUrl === 'string' ? profileUrl : '') || '未设置 URL'}</div></div>{active && <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">当前使用</span>}</div>{profile.note && <p className="line-clamp-2 text-xs text-muted-foreground">{profile.note}</p>}{requiresReview && <p className="text-xs text-amber-700 dark:text-amber-300">由旧供应商迁移而来，请核对高级原生配置。</p>}<div className="mt-auto flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => setEditing(toDraft(profile))}>编辑</Button><Button size="sm" variant="outline" disabled={busy || active} onClick={() => run(() => activateAgentProfile(agentKind, profile.id), `已切换到“${profile.name}”。`)}>切换</Button><Button size="sm" variant="ghost" title="测试连接" aria-label={`测试“${profile.name}”连接`} disabled={busy} onClick={() => test(profile)}><Zap className="size-3.5" /></Button><Button size="sm" variant="ghost" title="删除供应商" aria-label={`删除供应商“${profile.name}”`} disabled={busy} onClick={() => setDeleteTarget({ id: profile.id, name: profile.name })}><Trash2 className="size-3.5 text-destructive" /></Button></div></div>; })}
          <button type="button" onClick={() => setEditing(emptyDraft())} className="flex min-h-42 items-center justify-center gap-2 rounded-xl border border-dashed border-border/65 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"><Plus className="size-4" />新建 {agent.label} 供应商</button>
        </div>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除供应商"
        description={`确定要删除供应商"${deleteTarget?.name ?? ''}"吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={async () => { if (deleteTarget) { await deleteAgentProfile(deleteTarget.id); setDeleteTarget(null); toast.success('供应商已删除。'); } }}
      />
    </div>
  );
}
