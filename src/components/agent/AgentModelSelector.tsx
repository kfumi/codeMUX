import { useEffect, useMemo, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { Loader2 } from 'lucide-react';

import { ProviderBrandIcon } from '@/components/settings/ProviderBrandIcon';
import { ModelSelector, type ModelOption } from '@/components/model-selector';
import { ReasoningEffortSelector } from './ReasoningEffortSelector';
import { cn } from '@/lib/utils';
import { getProviderModel } from '@/lib/modelProviders';
import { coerceToOptions, effortOptionsForModel } from '@/lib/reasoningEffort';
import { registerThoughtLevelCycle } from '@/lib/shortcuts/thoughtLevelCycle';
import {
  OPENCODE_FREE_GROUP,
  OPENCODE_FREE_PROVIDER_ID,
  decodeModelSelectorValue,
  encodeModelSelectorValue,
  useAgentModels,
} from '../../hooks/useAgentModels';
import type { ModelProvider } from '../../types/provider';
import type { AgentKind, ReasoningEffort } from '../../types/session';
import { formatModelDisplayName } from './modelDisplay';

export interface AgentModelSelectorProps {
  agentKind: AgentKind;
  /** All model providers; usable ones are listed and grouped. */
  providers: ModelProvider[];
  /** Currently selected provider id (session or active). */
  activeProviderId: string | null;
  value: string;
  contextModel?: string;
  onChange: (modelId: string, providerId: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  compact?: boolean;
  /**
   * Where the thinking-level control lives.
   *
   * - `"dropdown"` (default) — the standalone select beside the trigger. The
   *   default keeps every host that is *not* the conversation send box on its
   *   existing UI: the work-task editor and the automation editor.
   * - `"slider"` — the slider inside the model popover, under the model list, so
   *   picking a model and picking a level are one gesture. Used by the two states
   *   of the conversation send box: `AgentPanel` (session active) and
   *   `NewSessionPanel` (no session yet — the cold-start home page).
   */
  effortControl?: 'dropdown' | 'slider';
  /** 向 assistant-ui 运行时注册模型上下文（供 composer 读取）。仅在
   *  AuiProvider 内有意义——脱离会话运行时的宿主（如工作任务的编辑对话框）
   *  必须传 false，否则 register 在 effect 里抛 "requires an AuiProvider"。 */
  enableModelContextRegistration?: boolean;
}

type ProviderFilter = {
  id: string;
  name: string;
  templateId: string | null;
};

function stopChipKeys(event: React.KeyboardEvent) {
  // Keep chip focus from being stolen by cmdk list navigation.
  if (
    event.key === 'ArrowLeft'
    || event.key === 'ArrowRight'
    || event.key === 'Home'
    || event.key === 'End'
    || event.key === ' '
    || event.key === 'Enter'
  ) {
    event.stopPropagation();
  }
}

export function AgentModelSelector({
  agentKind,
  providers,
  activeProviderId,
  value,
  contextModel,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  compact,
  effortControl = 'dropdown',
  enableModelContextRegistration = true,
}: AgentModelSelectorProps) {
  const useEffortSlider = effortControl === 'slider';
  const api = useAui();
  const { models, isLoading, freePending } = useAgentModels(agentKind, providers, activeProviderId);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  // 免费目录在途时会话绑定的免费模型还不在列表里：垫一个「模型加载中」占位
  // 条目，而不是回落到第一个供应商模型 —— 那会让会话看起来绑错了模型，目录
  // 回来后又跳走。目录加载失败时占位随 pending 一起消失，回落维持原行为。
  // 只放进 Root 的 models 供 Value 解析，不进下拉列表（无可选项）。
  const pendingFreeModelId = useMemo(() => {
    if (!freePending || !value.trim()) return null;
    if (activeProviderId
      && models.some((model) => model.id === encodeModelSelectorValue(activeProviderId, value))) {
      return null;
    }
    if (models.some((model) => model.modelId === value)) return null;
    return value;
  }, [activeProviderId, freePending, models, value]);
  const pendingFreeOptionId = pendingFreeModelId
    ? encodeModelSelectorValue(OPENCODE_FREE_PROVIDER_ID, pendingFreeModelId)
    : null;

  const selectorValue = useMemo(() => {
    if (activeProviderId && value) {
      const exact = encodeModelSelectorValue(activeProviderId, value);
      if (models.some((model) => model.id === exact)) return exact;
    }
    if (value) {
      const byModel = models.find((model) => model.modelId === value);
      if (byModel) return byModel.id;
    }
    if (pendingFreeOptionId) return pendingFreeOptionId;
    return models[0]?.id ?? '';
  }, [activeProviderId, models, value, pendingFreeOptionId]);

  const effectiveModelId =
    models.find((model) => model.id === selectorValue)?.modelId || value || models[0]?.modelId || '';
  const contextModelSupportsEfforts = models.find(
    (model) => model.modelId === (contextModel ?? effectiveModelId),
  )?.efforts;
  // 档位按**当前选中的模型**收窄，而不是 `contextModel`——后者是运行时会话
  // 绑定的模型，可能和选择器显示的不同。
  const selectedModel = useMemo(() => {
    const decoded = decodeModelSelectorValue(selectorValue);
    if (decoded) {
      const found = getProviderModel(providers, decoded.providerId, decoded.modelId);
      if (found) return found;
    }
    return getProviderModel(providers, activeProviderId, effectiveModelId);
  }, [activeProviderId, effectiveModelId, providers, selectorValue]);
  // Always resolves to a concrete list, never `undefined`. An undeclared
  // `thinking_levels` means the full ladder — the same thing the standalone
  // dropdown showed. Do *not* fall back to the model's `efforts` flag instead:
  // free catalog models carry `efforts: false` (see `toOpenCodeFreeModelOption`)
  // purely as a conservative default, so deferring to it would make the control
  // disappear on the models the new-session page starts on.
  const effortOptions = useMemo(
    () => effortOptionsForModel(selectedModel),
    [selectedModel],
  );

  useEffect(() => {
    // 只有滑块模式注册「切换思考强度」（`Mod+T`）：档位阶梯是按当前模型收窄的，
    // 只有这里知道该循环哪几档；下拉模式的宿主（工单任务 / 自定化的编辑对话框）
    // 仍用各自的独立控件，不该被这条全局命令碰到。单档位没什么可切，也不注册。
    if (!useEffortSlider || effortOptions.length < 2) return undefined;
    return registerThoughtLevelCycle(() => {
      // 先吸附再循环：会话可能停在当前模型已不提供的档位上。
      const current = coerceToOptions(reasoningEffort ?? '', effortOptions);
      const index = effortOptions.findIndex((level) => level.id === current);
      const next = effortOptions[(index + 1) % effortOptions.length];
      if (next) onReasoningEffortChange(next.id);
    });
  }, [useEffortSlider, effortOptions, reasoningEffort, onReasoningEffortChange]);

  useEffect(() => {
    // 脱离 AuiProvider 的宿主不注册（见 props 注释）——modelContext() 会直接抛错。
    if (!enableModelContextRegistration) return undefined;
    const registeredModel = contextModel ?? effectiveModelId;
    if (!registeredModel) return undefined;
    const config = {
      modelName: registeredModel,
      ...(contextModelSupportsEfforts ? { reasoningEffort } : undefined),
    };
    return api.modelContext().register({
      getModelContext: () => ({ config }),
    });
  }, [api, effectiveModelId, contextModel, reasoningEffort, contextModelSupportsEfforts, enableModelContextRegistration]);

  useEffect(() => {
    if (!value && !isLoading && models[0]) {
      onChange(models[0].modelId, models[0].providerId);
    }
  }, [value, isLoading, models, onChange]);

  useEffect(() => {
    if (
      providerFilter
      && !models.some((model) => model.providerId === providerFilter)
    ) {
      setProviderFilter(null);
    }
  }, [models, providerFilter]);

  const modelOptions: ModelOption[] = useMemo(() => {
    const options = models.map((model) => ({
      id: model.id,
      name: formatModelDisplayName({
        model: model.name,
        agentKind,
      }),
      group: model.group,
      description: model.description,
      // The resolved ladder, not the raw `efforts` flag. ModelSelector derives
      // the levels it offers *and* resolves the current level against them, so
      // handing it the flag would make it drop the level entirely for free
      // catalog models (`efforts: false`) and render the control at the bottom
      // of the ladder instead of where the session actually is.
      efforts: effortOptionsForModel(
        getProviderModel(providers, model.providerId, model.modelId),
      ),
      keywords: [model.group, model.modelId, model.name, model.providerId],
      icon: (
        <ProviderBrandIcon
          templateId={model.providerTemplateId}
          name={model.group}
          className="h-5 w-5"
          size={14}
        />
      ),
    }));
    if (pendingFreeOptionId && pendingFreeModelId) {
      options.unshift({
        id: pendingFreeOptionId,
        // trigger 直接显示加载态：不看下拉也要能感知「正在等目录」，而不是
        // 静默显示一个模型名。模型 id 放进 description/keywords 保留线索。
        name: '模型加载中…',
        group: OPENCODE_FREE_GROUP,
        description: pendingFreeModelId,
        efforts: effortOptionsForModel(null),
        keywords: [pendingFreeModelId],
        icon: (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
        ),
      });
    }
    return options;
  }, [agentKind, models, providers, pendingFreeOptionId, pendingFreeModelId]);

  const providerFilters: ProviderFilter[] = useMemo(() => {
    const seen = new Map<string, ProviderFilter>();
    for (const model of models) {
      if (seen.has(model.providerId)) continue;
      seen.set(model.providerId, {
        id: model.providerId,
        name: model.group,
        templateId: model.providerTemplateId,
      });
    }
    return Array.from(seen.values());
  }, [models]);

  const visibleGroups = useMemo(() => {
    const filtered = providerFilter
      ? models.filter((model) => model.providerId === providerFilter)
      : models;
    const groups: Array<{ id: string; name: string; models: ModelOption[] }> = [];
    const indexByProvider = new Map<string, number>();

    for (const model of filtered) {
      const option = modelOptions.find((item) => item.id === model.id);
      if (!option) continue;
      const existing = indexByProvider.get(model.providerId);
      if (existing === undefined) {
        indexByProvider.set(model.providerId, groups.length);
        groups.push({
          id: model.providerId,
          name: model.group,
          models: [option],
        });
        continue;
      }
      groups[existing]!.models.push(option);
    }
    return groups;
  }, [modelOptions, models, providerFilter]);

  return (
    <div className="flex min-w-0 items-center">
      <ModelSelector.Root
      models={modelOptions}
      value={selectorValue}
      onValueChange={(nextValue) => {
        const selected = models.find((model) => model.id === nextValue);
        if (selected) {
          onChange(selected.modelId, selected.providerId);
        }
      }}
      effort={reasoningEffort}
      onEffortChange={(effort) => onReasoningEffortChange(effort as ReasoningEffort)}
    >
      <ModelSelector.Trigger
        variant="ghost"
        size={compact ? 'sm' : 'default'}
        disabled={disabled || isLoading || models.length === 0}
        className="min-w-0 max-w-full"
      >
        {/* With the slider the level only lives inside the popover, so the
            trigger has to carry it — otherwise there is no way to read the
            current level without opening the popover. */}
        <ModelSelector.Value showEffort={useEffortSlider} hideName={compact} />
      </ModelSelector.Trigger>
      <ModelSelector.Content className="w-80" searchable>
        <ModelSelector.Search placeholder="搜索模型..." />

        {providerFilters.length > 1 && (
          <div
            className="flex flex-wrap gap-1.5 border-b border-border/60 px-2.5 py-2"
            onKeyDown={stopChipKeys}
          >
            <button
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 text-ui-caption font-medium transition-colors',
                providerFilter === null
                  ? 'bg-foreground text-background'
                  : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              onClick={() => setProviderFilter(null)}
            >
              全部
            </button>
            {providerFilters.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-ui-caption font-medium transition-colors',
                  providerFilter === provider.id
                    ? 'bg-foreground text-background'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={() => setProviderFilter(provider.id)}
              >
                <ProviderBrandIcon
                  templateId={provider.templateId}
                  name={provider.name}
                  className="h-4 w-4"
                  size={12}
                />
                <span className="max-w-24 truncate">{provider.name}</span>
              </button>
            ))}
          </div>
        )}

        <ModelSelector.List>
          <ModelSelector.Empty />
          {visibleGroups.map((group) => (
            <ModelSelector.Group key={group.id} heading={group.name}>
              {group.models.map((model) => (
                <ModelSelector.Item key={model.id} model={model} />
              ))}
            </ModelSelector.Group>
          ))}
        </ModelSelector.List>
        {useEffortSlider ? (
          // Sibling of the list, never inside it: `[cmdk-list]` is a listbox and
          // only accepts options, and cmdk's filter re-orders the list's
          // children.
          <ModelSelector.Effort
            options={effortOptions}
            disabled={disabled || isLoading || models.length === 0}
          />
        ) : null}
      </ModelSelector.Content>
      </ModelSelector.Root>
      {useEffortSlider ? null : (
        <ReasoningEffortSelector
          value={reasoningEffort}
          onChange={onReasoningEffortChange}
          disabled={disabled || isLoading || models.length === 0}
          compact={compact}
          options={effortOptions}
        />
      )}
    </div>
  );
}
