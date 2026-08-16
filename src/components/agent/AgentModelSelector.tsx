import { useEffect, useMemo, useState } from 'react';
import { useAui } from '@assistant-ui/react';

import { ProviderBrandIcon } from '@/components/settings/ProviderBrandIcon';
import { ModelSelector, type ModelOption } from '@/components/model-selector';
import { ReasoningEffortSelector } from './ReasoningEffortSelector';
import { cn } from '@/lib/utils';
import {
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
}: AgentModelSelectorProps) {
  const api = useAui();
  const { models, isLoading } = useAgentModels(agentKind, providers, activeProviderId);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  const selectorValue = useMemo(() => {
    if (!models.length) return '';
    if (activeProviderId && value) {
      const exact = encodeModelSelectorValue(activeProviderId, value);
      if (models.some((model) => model.id === exact)) return exact;
    }
    if (value) {
      const byModel = models.find((model) => model.modelId === value);
      if (byModel) return byModel.id;
    }
    return models[0]?.id ?? '';
  }, [activeProviderId, models, value]);

  const effectiveModelId =
    models.find((model) => model.id === selectorValue)?.modelId || value || models[0]?.modelId || '';
  const contextModelSupportsEfforts = models.find(
    (model) => model.modelId === (contextModel ?? effectiveModelId),
  )?.efforts;

  useEffect(() => {
    const registeredModel = contextModel ?? effectiveModelId;
    if (!registeredModel) return;
    const config = {
      modelName: registeredModel,
      ...(contextModelSupportsEfforts ? { reasoningEffort } : undefined),
    };
    return api.modelContext().register({
      getModelContext: () => ({ config }),
    });
  }, [api, effectiveModelId, contextModel, reasoningEffort, contextModelSupportsEfforts]);

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

  const modelOptions: ModelOption[] = useMemo(
    () =>
      models.map((model) => ({
        id: model.id,
        name: formatModelDisplayName({
          model: model.name,
          agentKind,
        }),
        group: model.group,
        description: model.description,
        efforts: model.efforts,
        keywords: [model.group, model.modelId, model.name, model.providerId],
        icon: (
          <ProviderBrandIcon
            templateId={model.providerTemplateId}
            name={model.group}
            className="h-5 w-5"
            size={14}
          />
        ),
      })),
    [agentKind, models],
  );

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
        <ModelSelector.Value showEffort={false} hideName={compact} />
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
                'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
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
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition-colors',
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
      </ModelSelector.Content>
      </ModelSelector.Root>
      <ReasoningEffortSelector
        value={reasoningEffort}
        onChange={onReasoningEffortChange}
        disabled={disabled || isLoading || models.length === 0}
        compact={compact}
      />
    </div>
  );
}
