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
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  compact,
}: AgentModelSelectorProps) {
  const api = useAui();
  const { models } = useAgentModels(agentKind, activeProfile, activeProfileId);

  useEffect(() => {
    if (!value) return;
    return api.modelContext().register({
      getModelContext: () => ({
        config: {
          modelName: value,
          reasoningEffort,
        },
      }),
    });
  }, [api, value, reasoningEffort]);

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
      value={value}
      onValueChange={onChange}
      effort={reasoningEffort}
      onEffortChange={(effort) => onReasoningEffortChange(effort as ReasoningEffort)}
    >
      <ModelSelector.Trigger
        variant="ghost"
        size="sm"
        disabled={disabled}
        className={compact ? 'min-w-0' : undefined}
      />
      <ModelSelector.Content searchable />
    </ModelSelector.Root>
  );
}
