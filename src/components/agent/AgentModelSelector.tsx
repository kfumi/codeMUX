import { useEffect } from 'react';
import { useAui } from '@assistant-ui/react';
import { ModelSelector } from '@/components/model-selector';
import { useAgentModels } from '../../hooks/useAgentModels';
import { formatModelDisplayName } from './modelDisplay';
import type { AgentKind, ReasoningEffort } from '../../types/session';
import type { AgentProviderProfile } from '../../types/provider';

export interface AgentModelSelectorProps {
  agentKind: AgentKind;
  activeProfile: AgentProviderProfile | null;
  activeProfileId: string | null;
  value: string;
  contextModel?: string;
  onChange: (modelId: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function AgentModelSelector({
  agentKind,
  activeProfile,
  activeProfileId,
  value,
  contextModel,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  compact,
}: AgentModelSelectorProps) {
  const api = useAui();
  const { models, isLoading } = useAgentModels(agentKind, activeProfile, activeProfileId);
  const effectiveValue = value || models[0]?.id || '';
  const contextModelSupportsEfforts = models.find((model) => model.id === (contextModel ?? effectiveValue))?.efforts;

  useEffect(() => {
    const registeredModel = contextModel ?? effectiveValue;
    if (!registeredModel) return;
    const config = {
      modelName: registeredModel,
      ...(contextModelSupportsEfforts ? { reasoningEffort } : undefined),
    };
    return api.modelContext().register({
      getModelContext: () => ({ config }),
    });
  }, [api, effectiveValue, contextModel, reasoningEffort, contextModelSupportsEfforts]);

  const modelOptions = models.map((m) => ({
    id: m.id,
    name: formatModelDisplayName({
      model: m.name,
      agentKind,
    }),
    description: m.description,
    efforts: m.efforts,
  }));

  return (
    <ModelSelector.Root
      models={modelOptions}
      value={effectiveValue}
      onValueChange={(nextModel) => {
        if (models.some((model) => model.id === nextModel)) {
          onChange(nextModel);
        }
      }}
      effort={reasoningEffort}
      onEffortChange={(effort) => onReasoningEffortChange(effort as ReasoningEffort)}
    >
      <ModelSelector.Trigger
        variant="ghost"
        size="sm"
        disabled={disabled || isLoading}
        className={compact ? 'min-w-0 max-w-32' : undefined}
      >
        <ModelSelector.Value
          showEffort={!compact}
          className={compact ? 'max-w-24' : undefined}
        />
      </ModelSelector.Trigger>
      <ModelSelector.Content />
    </ModelSelector.Root>
  );
}
