import { useEffect, useMemo } from 'react';

import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { renderCommandPrompt } from '../../lib/slashCommands';
import { mapExecutionModeToPermissionConfig, serializePermissionConfig } from '../../lib/agentPermissions';
import { agentApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAgentModels } from '../../hooks/useAgentModels';
import type { ModelOption } from '../../hooks/useAgentModels';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentInputPayload } from '../../types/agentInput';
import { AgentSelector } from './AgentSelector';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { AgentModelSelector } from './AgentModelSelector';

const CLAUDE_CODE_BUILTIN_MODEL_IDS = new Set(['sonnet', 'opus', 'fable', 'haiku']);

function isCurrentDraftSubmissionAvailable(
  renderedProfileId: string | null,
  renderedModels: ModelOption[],
  areModelsLoading: boolean,
): boolean {
  const currentStore = useNewSessionStore.getState();
  const currentConfig = useSettingsStore.getState().config;
  const currentAgentKind = currentStore.selectedAgentKind;
  const isProfileAgent = currentAgentKind === 'claude_code'
    || currentAgentKind === 'codex'
    || currentAgentKind === 'opencode';

  if (!isProfileAgent) return true;

  const activeProfileId = currentConfig?.agent_profile_registry?.active_profile_ids?.[currentAgentKind] ?? null;
  if (activeProfileId !== renderedProfileId) return false;
  const activeProfile = currentConfig?.agent_profile_registry?.profiles.find(
    (profile) => profile.id === activeProfileId && profile.agent_kind === currentAgentKind,
  ) ?? null;

  if (currentAgentKind === 'claude_code' && !activeProfileId) {
    return !currentStore.selectedModel || CLAUDE_CODE_BUILTIN_MODEL_IDS.has(currentStore.selectedModel);
  }
  if (currentAgentKind === 'opencode' && !activeProfileId) {
    return !currentStore.selectedModel
      || renderedModels.some((model) => model.id === currentStore.selectedModel)
      || currentStore.selectedModel.startsWith('opencode/');
  }
  if (!activeProfileId || !activeProfile || areModelsLoading) return false;

  if (!currentStore.selectedModel) {
    return activeProfile.models.some((model) => model.id.trim());
  }

  return activeProfile.models.some((model) => model.id === currentStore.selectedModel)
    || (currentAgentKind === 'claude_code'
      ? CLAUDE_CODE_BUILTIN_MODEL_IDS.has(currentStore.selectedModel)
      : renderedModels.some((model) => model.id === currentStore.selectedModel && model.source !== 'profile'));
}

interface NewSessionPanelProps {
  onSubmit: (input: AgentInputPayload) => Promise<void> | void;
}

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const {
    selectedAgentKind,
    selectedModel,
    selectedReasoningEffort,
    selectedPermissionConfig,
    selectedPlanMode,
    setSelectedAgentKind,
    setSelectedModel,
    setSelectedReasoningEffort,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
    draftProjectId,
  } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((s) => s.config);
  const getActiveProvider = useSettingsStore((s) => s.getActiveProvider);
  const { setProjectPath } = usePreviewStore();
  const clearEvents = useAgentStore((state) => state.clearEvents);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const isProfileAgent = selectedAgentKind === 'claude_code' || selectedAgentKind === 'codex' || selectedAgentKind === 'opencode';
  const profileRegistry = config?.agent_profile_registry;
  const availableProfiles = useMemo(
    () => isProfileAgent ? (profileRegistry?.profiles ?? []).filter((profile) => profile.agent_kind === selectedAgentKind) : [],
    [isProfileAgent, profileRegistry?.profiles, selectedAgentKind],
  );
  const activeProfileId = isProfileAgent ? profileRegistry?.active_profile_ids?.[selectedAgentKind] ?? null : null;
  const activeProfile = availableProfiles.find((profile) => profile.id === activeProfileId) ?? null;
  const { models, isLoading: areModelsLoading } = useAgentModels(selectedAgentKind, activeProfile, activeProfileId);
  const effectiveModel = selectedModel || activeProfile?.models.find((model) => model.id.trim())?.id.trim() || models[0]?.id || '';
  const selectedModelIsAvailable = !selectedModel
    || models.some((model) => model.id === selectedModel)
    || (selectedAgentKind === 'claude_code' && CLAUDE_CODE_BUILTIN_MODEL_IDS.has(selectedModel));
  const selectedModelBelongsToActiveProfile = !selectedModel || activeProfile?.models.some((model) => model.id === selectedModel);
  const usesClaudeDefault = selectedAgentKind === 'claude_code' && !activeProfileId;
  const usesOpenCodeFree = selectedAgentKind === 'opencode' && !activeProfileId;
  const hasUsableProfile = !isProfileAgent
    || (usesClaudeDefault
      ? Boolean(!selectedModel || (!areModelsLoading && selectedModelIsAvailable))
      : (usesOpenCodeFree
        ? Boolean(!selectedModel || (!areModelsLoading && selectedModelIsAvailable))
        : Boolean(
          activeProfileId
            && effectiveModel
            && !areModelsLoading
            && selectedModelIsAvailable
            && (selectedModelBelongsToActiveProfile
              || selectedAgentKind === 'claude_code' && CLAUDE_CODE_BUILTIN_MODEL_IDS.has(selectedModel ?? '')
              || selectedAgentKind === 'codex'
              || selectedAgentKind === 'opencode'),
        )));

  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );
  const projectName = draftProject?.name ?? '';
  const title = projectName
    ? `我们应该在 ${projectName} 中构建什么？`
    : '我们应该做什么？';
  const placeholder = useMemo(() => {
    const label = selectedAgent?.label ?? 'Claude Code';
    return `给 ${label} 发送第一条任务指令... (@ 引用文件, / 查看命令)`;
  }, [selectedAgent]);

  useEffect(() => {
    if (draftProject?.path) {
      setProjectPath(draftProject.path);
    } else {
      setProjectPath(null);
      usePreviewStore.setState({ treeRoot: null, treeRootPath: null });
    }
  }, [draftProject?.path, setProjectPath]);

  useEffect(() => {
    const configured = selectedAgentKind === 'codex'
      ? config?.agent_configs.codex.permission_config
      : config?.agent_configs.claude_code.permission_config;
    setSelectedPermissionConfig(serializePermissionConfig(selectedAgentKind, configured));
    setSelectedPlanMode('off');
  }, [
    config?.agent_configs.claude_code.permission_config,
    config?.agent_configs.codex.permission_config,
    selectedAgentKind,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
  ]);

  useEffect(() => {
    if (!isProfileAgent) return;
    const active = availableProfiles.find((profile) => profile.id === activeProfileId);
    if (!active) {
      setSelectedModel(null);
      return;
    }
    setSelectedModel(active.models.find((model) => model.id.trim())?.id.trim() || null);
  }, [activeProfileId, availableProfiles, isProfileAgent, setSelectedModel]);

  const handleSend = async (input: AgentInputPayload | string) => {
    const currentStore = useNewSessionStore.getState();
    if (currentStore.selectedAgentKind !== selectedAgentKind
      || !isCurrentDraftSubmissionAvailable(activeProfileId, models, areModelsLoading)) {
      return;
    }
    if (isProfileAgent && effectiveModel !== selectedModel) {
      setSelectedModel(effectiveModel);
    }
    const payload = typeof input === 'string' ? { text: input } : input;
    await onSubmit(payload);
  };

  const handleCommand = async (command: SlashCommand, args: string) => {
    if (command.handler === 'local' && command.action) {
      const context: CommandContext = {
        sessionId: 'new-session-draft',
        cwd: draftProject?.path ?? '',
        showInfoDialog: () => {},
        createSession: async () => {},
        clearEvents,
        resetSession: () => { agentApi.resetSession('new-session-draft'); },
        deleteClaudeSessionFiles: () => agentApi.deleteClaudeSessionFiles('new-session-draft'),
        getActiveProvider: () => getActiveProvider(),
        getTheme: () => config?.theme || 'System',
      };
      await command.action(context, args);
      return;
    }

    if (command.handler === 'prompt' && command.prompt) {
      if (selectedAgentKind === 'codex' && command.name === 'plan') {
        setSelectedPlanMode('on');
        if (!args) {
          return;
        }
      }

      await handleSend({ text: renderCommandPrompt(command, args) });
    }
  };

  return (
    <div className="flex flex-1 overflow-auto bg-[hsl(var(--background))] transition-[background] duration-300">
      <CodeMuxAssistantRuntimeProvider
        sessionId="new-session-draft"
        agentKind={selectedAgentKind}
        onSend={handleSend}
        onCommand={handleCommand}
        sendDisabled={!hasUsableProfile}
      >
        <div className="mx-auto flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[360ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
            <div className="mb-10 flex flex-col items-center gap-4">
              <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} variant="hero" />
              <h1 className="text-center text-[26px] font-semibold leading-tight text-foreground sm:text-[30px]">
                {title}
              </h1>
            </div>

            <CodeMuxComposer
              sessionId="new-session-draft"
              agentKind={selectedAgentKind}
              projectPath={draftProject?.path}
              placeholder={placeholder}
              disabled={!hasUsableProfile}
              modelSelector={(
                <AgentModelSelector
                  agentKind={selectedAgentKind}
                  activeProfile={activeProfile}
                  activeProfileId={activeProfileId}
                  value={effectiveModel}
                  onChange={setSelectedModel}
                  reasoningEffort={selectedReasoningEffort}
                  onReasoningEffortChange={setSelectedReasoningEffort}
                />
              )}
              permissionSelector={(
                <AgentPermissionSelector
                  agentKind={selectedAgentKind}
                  permissionConfig={selectedPermissionConfig}
                  planMode={selectedPlanMode}
                  onPermissionConfigChange={setSelectedPermissionConfig}
                  onPlanModeChange={setSelectedPlanMode}
                />
              )}
              onActivatePlanMode={selectedAgentKind === 'opencode' ? undefined : () => {
                setSelectedPermissionConfig(mapExecutionModeToPermissionConfig(selectedAgentKind, 'plan'));
                setSelectedPlanMode('on');
              }}
            />

          </div>
        </div>
      </CodeMuxAssistantRuntimeProvider>
    </div>
  );
}
