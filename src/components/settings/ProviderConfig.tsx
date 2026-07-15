import { Eye, EyeOff, Loader2, Plus, Trash2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

import { modelsFromText, modelsToText } from '../../lib/providerModels';
import { applyClaudeFormToSettings, CLAUDE_SETTINGS_DEFAULT, parseClaudeSettingsDraft, type ClaudeSettingsForm } from '../../lib/claudeSettingsConfig';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentProviderProfile, AgentProviderProfileUpsert } from '../../types/provider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';

type ProfileAgentKind = 'claude_code' | 'codex' | 'opencode';
type ProfileDraft = { id: string; name: string; note: string; models: string; apiKey: string; clearApiKey: boolean; baseUrl: string; context1m: boolean; codexNeedsProxy: boolean; advancedConfig: string; clearAdvancedConfig: boolean; claudeForm: ClaudeSettingsForm };

const AGENTS: Array<{ id: ProfileAgentKind; label: string; description: string; baseUrlLabel: string; placeholder: string }> = [
  { id: 'claude_code', label: 'Claude Code', description: '写入 Claude Code 的 settings.json 配置。', baseUrlLabel: 'Anthropic Base URL', placeholder: 'https://api.anthropic.com' },
  { id: 'codex', label: 'Codex', description: '写入 Codex 的 auth.json 和 config.toml 配置。', baseUrlLabel: 'OpenAI Base URL', placeholder: 'https://api.openai.com/v1' },
  { id: 'opencode', label: 'OpenCode', description: '写入 OpenCode 的 opencode.json 配置。', baseUrlLabel: 'OpenAI 兼容 Base URL', placeholder: 'https://api.openai.com/v1' },
];

function emptyDraft(): ProfileDraft {
  const settings = structuredClone(CLAUDE_SETTINGS_DEFAULT);
  const { form } = parseClaudeSettingsDraft(JSON.stringify(settings));
  return { id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2), name: '', note: '', models: '', apiKey: '', clearApiKey: false, baseUrl: '', context1m: false, codexNeedsProxy: false, advancedConfig: JSON.stringify(settings, null, 2), clearAdvancedConfig: false, claudeForm: form };
}

function toDraft(profile: AgentProviderProfile): ProfileDraft {
  const native = profile.native_config;
  const claudeEnv = native.type === 'claude_code' && native.settings.env && typeof native.settings.env === 'object'
    ? native.settings.env as Record<string, unknown>
    : {};
  const claudeSettings = native.type === 'claude_code' ? native.settings : CLAUDE_SETTINGS_DEFAULT;
  const parsedClaude = parseClaudeSettingsDraft(JSON.stringify(claudeSettings));
  return {
    id: profile.id, name: profile.name, note: profile.note, models: modelsToText(profile.models.map((model) => model.id)), apiKey: typeof claudeEnv.ANTHROPIC_AUTH_TOKEN === 'string' ? claudeEnv.ANTHROPIC_AUTH_TOKEN : '', clearApiKey: false,
    baseUrl: native.type === 'claude_code' ? (typeof claudeEnv.ANTHROPIC_BASE_URL === 'string' ? claudeEnv.ANTHROPIC_BASE_URL : '') : native.openai_base_url,
    context1m: false,
    codexNeedsProxy: native.type === 'codex' && Boolean(native.codex_needs_proxy),
    advancedConfig: JSON.stringify(parsedClaude.settings, null, 2), clearAdvancedConfig: false, claudeForm: parsedClaude.form,
  };
}

function profileToUpsert(agentKind: ProfileAgentKind, draft: ProfileDraft): AgentProviderProfileUpsert {
  const models = modelsFromText(draft.models).map((id) => ({ id, name: id }));
  const common = { id: draft.id, agent_kind: agentKind, name: draft.name.trim(), note: draft.note.trim(), models, default_model: models[0]?.id ?? '' };
  const advanced = draft.advancedConfig.trim() ? JSON.parse(draft.advancedConfig) : undefined;
  if (agentKind === 'claude_code') return { ...common, models: modelsFromText(draft.models).map((id) => ({ id, name: id })), default_model: draft.claudeForm.fallbackModel, native_config: { type: 'claude_code', settings: parseClaudeSettingsDraft(draft.advancedConfig).settings } };
  if (agentKind === 'codex') return { ...common, native_config: { type: 'codex', api_key: draft.apiKey || undefined, clear_api_key: draft.clearApiKey, openai_base_url: draft.baseUrl.trim(), codex_needs_proxy: draft.codexNeedsProxy, advanced_config: advanced, clear_advanced_config: draft.clearAdvancedConfig } };
  return { ...common, native_config: { type: 'opencode', api_key: draft.apiKey || undefined, clear_api_key: draft.clearApiKey, openai_base_url: draft.baseUrl.trim(), advanced_config: advanced, clear_advanced_config: draft.clearAdvancedConfig } };
}

export function ProviderConfigPanel() {
  const { config, upsertAgentProfile, activateAgentProfile, activateDefaultClaudeSupplier, deleteAgentProfile, testAgentProfile } = useSettingsStore();
  const [agentKind, setAgentKind] = useState<ProfileAgentKind>('claude_code');
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const profiles = useMemo(() => (config?.agent_profile_registry?.profiles ?? []).filter((profile) => profile.agent_kind === agentKind), [agentKind, config?.agent_profile_registry?.profiles]);
  const activeId = config?.agent_profile_registry?.active_profile_ids?.[agentKind] ?? null;
  const agent = AGENTS.find((item) => item.id === agentKind)!;

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setMessage(null);
    try { await action(); setMessage(success); } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
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
  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim() || (agentKind !== 'claude_code' && (!editing.baseUrl.trim() || !modelsFromText(editing.models).length))) { setMessage('请填写供应商名称、Base URL 和至少一个模型。'); return; }
    if (editing.clearApiKey && editing.apiKey) { setMessage('API Key 不能同时替换和清除。'); return; }
    try { profileToUpsert(agentKind, editing); } catch { setMessage(agentKind === 'claude_code' ? '配置 JSON 必须有效，且 env 必须是对象。' : '高级配置必须是有效的 JSON。'); return; }
    await run(async () => { await upsertAgentProfile(profileToUpsert(agentKind, editing)); setEditing(null); }, '供应商已保存。');
  };
  const test = async (profile: AgentProviderProfile) => {
    await run(async () => { await testAgentProfile(agentKind, profile.id); }, `“${profile.name}”连接正常。`);
  };

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="智能体供应商" className="inline-flex h-11 w-full items-center justify-start gap-1 rounded-xl bg-muted/55 p-1">
        {AGENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={agentKind === item.id} onClick={() => { setAgentKind(item.id); setEditing(null); setMessage(null); }} className={cn('rounded-lg px-4 py-2 text-sm font-medium transition-colors', agentKind === item.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{item.label}</button>)}
      </div>
      <div className="rounded-xl border border-border/50 bg-muted/25 px-4 py-3 text-sm text-foreground/65">{agent.description} 切换供应商或模型会影响之后新建或重新启动的会话，不会热更新正在运行的会话。</div>
      {message && <div className="rounded-lg border border-border/50 bg-muted/35 px-3 py-2 text-sm text-foreground/75">{message}</div>}
      {editing ? (
        <div className="space-y-5 rounded-2xl border border-border/55 bg-card/35 p-5">
          <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{profiles.some((profile) => profile.id === editing.id) ? '编辑供应商' : '新建供应商'}</h3><Button variant="ghost" size="sm" onClick={() => setEditing(null)}>返回列表</Button></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-foreground/60">供应商名称<Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="如 公司代理" /></label>
            <label className="space-y-1.5 text-xs text-foreground/60">备注（可选）<Input value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} placeholder="此供应商的用途说明" /></label>
          </div>
          {agentKind === 'claude_code' ? <>
            <label className="block space-y-1.5 text-xs text-foreground/60">API Key<div className="relative"><Input aria-label="API Key" type={showKey ? 'text' : 'password'} value={editing.claudeForm.apiKey} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, apiKey: event.target.value })} className="pr-10" /><button type="button" className="absolute right-2 top-2 text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>
            <label className="block space-y-1.5 text-xs text-foreground/60">Anthropic Base URL<Input value={editing.claudeForm.baseUrl} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, baseUrl: event.target.value })} placeholder="https://api.anthropic.com" /></label>
            <div className="space-y-3 border-y border-border/55 py-4"><div><h4 className="text-sm font-semibold">模型映射</h4><p className="mt-1 text-xs text-foreground/55">显示名称仅用于 /model 菜单，实际请求模型写入 Claude Code 配置。</p></div><div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_92px] gap-2 text-xs text-foreground/60"><span>模型角色</span><span>显示名称</span><span>实际请求模型</span><span>声明支持 1M</span><span className="self-center text-sm text-foreground">Sonnet</span><Input aria-label="Sonnet 显示名称" value={editing.claudeForm.sonnet.displayName} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, sonnet: { ...editing.claudeForm.sonnet, displayName: event.target.value } })} /><Input aria-label="Sonnet 实际请求模型" value={editing.claudeForm.sonnet.requestModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, sonnet: { ...editing.claudeForm.sonnet, requestModel: event.target.value } })} /><label className="flex items-center gap-2"><Switch checked={editing.claudeForm.sonnet.supports1m} onCheckedChange={(checked) => updateClaudeForm({ ...editing.claudeForm, sonnet: { ...editing.claudeForm.sonnet, supports1m: checked } })} />1M</label><span className="self-center text-sm text-foreground">Opus</span><Input aria-label="Opus 显示名称" value={editing.claudeForm.opus.displayName} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, opus: { ...editing.claudeForm.opus, displayName: event.target.value } })} /><Input aria-label="Opus 实际请求模型" value={editing.claudeForm.opus.requestModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, opus: { ...editing.claudeForm.opus, requestModel: event.target.value } })} /><label className="flex items-center gap-2"><Switch checked={editing.claudeForm.opus.supports1m} onCheckedChange={(checked) => updateClaudeForm({ ...editing.claudeForm, opus: { ...editing.claudeForm.opus, supports1m: checked } })} />1M</label><span className="self-center text-sm text-foreground">Fable</span><Input aria-label="Fable 显示名称" value={editing.claudeForm.fable.displayName} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, fable: { ...editing.claudeForm.fable, displayName: event.target.value } })} /><Input aria-label="Fable 实际请求模型" value={editing.claudeForm.fable.requestModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, fable: { ...editing.claudeForm.fable, requestModel: event.target.value } })} /><label className="flex items-center gap-2"><Switch checked={editing.claudeForm.fable.supports1m} onCheckedChange={(checked) => updateClaudeForm({ ...editing.claudeForm, fable: { ...editing.claudeForm.fable, supports1m: checked } })} />1M</label><span className="self-center text-sm text-foreground">Haiku</span><Input aria-label="Haiku 显示名称" value={editing.claudeForm.haiku.requestModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, haiku: { requestModel: event.target.value } })} /><Input aria-label="Haiku 实际请求模型" value={editing.claudeForm.haiku.requestModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, haiku: { requestModel: event.target.value } })} /><span /></div></div>
            <label className="block space-y-1.5 text-xs text-foreground/60">默认兜底模型<Input value={editing.claudeForm.fallbackModel} onChange={(event) => updateClaudeForm({ ...editing.claudeForm, fallbackModel: event.target.value })} /></label>
            <label className="block space-y-1.5 text-xs text-foreground/60">配置 JSON<textarea aria-label="配置 JSON" value={editing.advancedConfig} onChange={(event) => { const advancedConfig = event.target.value; try { const parsed = parseClaudeSettingsDraft(advancedConfig); setEditing({ ...editing, advancedConfig, claudeForm: parsed.form }); } catch { setEditing({ ...editing, advancedConfig }); } }} className="min-h-72 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring/40" /></label>
          </> : <>
            <label className="block space-y-1.5 text-xs text-foreground/60">{agent.baseUrlLabel}<Input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} placeholder={agent.placeholder} /></label>
            <label className="block space-y-1.5 text-xs text-foreground/60">API Key <span className="text-foreground/40">（已保存的密钥不会回传）</span><div className="relative"><Input aria-label="API Key" type={showKey ? 'text' : 'password'} value={editing.apiKey} onChange={(event) => setEditing({ ...editing, apiKey: event.target.value, clearApiKey: false })} placeholder="输入新密钥以替换" className="pr-10" /><button type="button" className="absolute right-2 top-2 text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>
            <label className="flex items-center gap-2 text-sm text-foreground/70"><Switch checked={editing.clearApiKey} onCheckedChange={(checked) => setEditing({ ...editing, clearApiKey: checked, apiKey: checked ? '' : editing.apiKey })} />清除已保存的 API Key</label><label className="block space-y-1.5 text-xs text-foreground/60">模型列表 <span className="text-foreground/40">（每行一个，第一行为默认模型）</span><textarea aria-label="模型列表" value={editing.models} onChange={(event) => setEditing({ ...editing, models: event.target.value })} className="min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring/40" /></label>{agentKind === 'codex' && <label className="flex items-center gap-2 text-sm text-foreground/70"><Switch checked={editing.codexNeedsProxy} onCheckedChange={(checked) => setEditing({ ...editing, codexNeedsProxy: checked })} />通过本地兼容代理路由</label>}<label className="block space-y-1.5 text-xs text-foreground/60">高级原生配置 JSON<textarea value={editing.advancedConfig} onChange={(event) => setEditing({ ...editing, advancedConfig: event.target.value, clearAdvancedConfig: false })} className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring/40" /></label><label className="flex items-center gap-2 text-sm text-foreground/70"><Switch checked={editing.clearAdvancedConfig} onCheckedChange={(checked) => setEditing({ ...editing, clearAdvancedConfig: checked, advancedConfig: checked ? '' : editing.advancedConfig })} />清除已保存的高级配置</label>
          </>}
          <div className="flex justify-end gap-2 border-t border-border/45 pt-4"><Button variant="outline" onClick={() => setEditing(null)}>取消</Button><Button disabled={busy} onClick={save}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}保存供应商</Button></div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(235px,1fr))] gap-3">
          {agentKind === 'claude_code' && <div className={cn('flex min-h-42 flex-col gap-3 rounded-xl border p-4', !activeId ? 'border-primary/45 bg-primary/5' : 'border-border/55 bg-muted/20')}><div><div className="font-medium">默认供应商</div><p className="mt-1 text-xs text-muted-foreground">直接使用 ~/.claude/settings.json</p></div>{!activeId && <span className="w-fit rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">当前使用</span>}<div className="mt-auto"><Button size="sm" variant="outline" disabled={busy || !activeId} onClick={() => run(() => activateDefaultClaudeSupplier(), '已切换到默认供应商。')}>切换</Button></div></div>}
          {profiles.map((profile) => { const active = profile.id === activeId; const requiresReview = Boolean(profile.native_config.requires_review); return <div key={profile.id} className={cn('flex min-h-42 flex-col gap-3 rounded-xl border p-4', active ? 'border-primary/45 bg-primary/5' : 'border-border/55 bg-muted/20')}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate font-medium">{profile.name}</div><div className="mt-1 truncate font-mono text-xs text-muted-foreground">{profile.default_model || '未设置模型'}</div></div>{active && <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">当前使用</span>}</div>{profile.note && <p className="line-clamp-2 text-xs text-muted-foreground">{profile.note}</p>}{requiresReview && <p className="text-xs text-amber-700 dark:text-amber-300">由旧供应商迁移而来，请核对高级原生配置。</p>}<div className="mt-auto flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => setEditing(toDraft(profile))}>编辑</Button><Button size="sm" variant="outline" disabled={busy || active} onClick={() => run(() => activateAgentProfile(agentKind, profile.id), `已切换到“${profile.name}”。`)}>切换</Button><Button size="sm" variant="ghost" title="测试连接" disabled={busy} onClick={() => test(profile)}><Zap className="size-3.5" /></Button><Button size="sm" variant="ghost" title="删除供应商" disabled={busy} onClick={() => run(() => deleteAgentProfile(profile.id), '供应商已删除。')}><Trash2 className="size-3.5 text-destructive" /></Button></div></div>; })}
          <button type="button" onClick={() => setEditing(emptyDraft())} className="flex min-h-42 items-center justify-center gap-2 rounded-xl border border-dashed border-border/65 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"><Plus className="size-4" />新建 {agent.label} 供应商</button>
        </div>
      )}
    </div>
  );
}
