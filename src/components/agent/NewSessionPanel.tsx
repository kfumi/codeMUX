import { useEffect, useMemo } from 'react';

import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { renderCommandPrompt } from '../../lib/slashCommands';
import { getPrimaryProviderModel, getProviderModelList } from '../../lib/providerModels';
import { getProfilePrimaryModel, profileToSelectorProvider } from '../../lib/agentProfileSelector';
import { mapExecutionModeToPermissionConfig, serializePermissionConfig } from '../../lib/agentPermissions';
import { agentApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentInputPayload } from '../../types/agentInput';
import { AgentSelector } from './AgentSelector';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
import { formatModelDisplayName } from './modelDisplay';

interface NewSessionPanelProps {
  onSubmit: (input: AgentInputPayload) => Promise<void> | void;
}

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const {
    selectedAgentKind,
    selectedProviderId,
    selectedModel,
    selectedReasoningEffort,
    selectedPermissionConfig,
    selectedPlanMode,
    setSelectedAgentKind,
    setSelectedProviderId,
    setSelectedModel,
    setSelectedReasoningEffort,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
    draftProjectId,
  } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((s) => s.config);
  const getActiveProvider = useSettingsStore((s) => s.getActiveProvider);
  const activateAgentProfile = useSettingsStore((s) => s.activateAgentProfile);
  const { loadFileTree, setProjectPath } = usePreviewStore();
  const clearEvents = useAgentStore((state) => state.clearEvents);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const isProfileAgent = selectedAgentKind === 'claude_code' || selectedAgentKind === 'codex' || selectedAgentKind === 'opencode';
  const profileRegistry = config?.agent_profile_registry;
  const availableProfiles = useMemo(
    () => isProfileAgent ? (profileRegistry?.profiles ?? []).filter((profile) => profile.agent_kind === selectedAgentKind) : [],
    [isProfileAgent, profileRegistry?.profiles, selectedAgentKind],
  );
  const activeProfileId = isProfileAgent ? profileRegistry?.active_profile_ids?.[selectedAgentKind] ?? null : null;
  const availableProviders = useMemo(
    () => availableProfiles.map(profileToSelectorProvider),
    [availableProfiles],
  );
  const selectedProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === selectedProviderId)
      ?? availableProviders.find((provider) => provider.id === activeProfileId)
      ?? null,
    [activeProfileId, availableProviders, selectedProviderId],
  );
  const providerModels = useMemo(() => getProviderModelList(selectedProvider), [selectedProvider]);
  const effectiveModel = selectedModel || getPrimaryProviderModel(selectedProvider);
  const usesClaudeDefault = selectedAgentKind === 'claude_code' && !activeProfileId;
  const hasUsableProfile = usesClaudeDefault || !isProfileAgent || Boolean(
    activeProfileId
      && selectedProvider?.id === activeProfileId
      && effectiveModel
      && providerModels.includes(effectiveModel),
  );
  const profileRequiredMessage = isProfileAgent && !hasUsableProfile
    ? `请先在供应商配置中为 ${selectedAgent?.label ?? '当前智能体'} 添加至少一个模型。`
    : undefined;
  const formatSelectedProviderModel = useMemo(() => (
    (item: string) => formatModelDisplayName({
      model: item,
      agentKind: selectedAgentKind,
      usesLargeContext: selectedProvider?.context_1m,
    })
  ), [selectedProvider?.context_1m, selectedAgentKind]);
  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );
  const draftProjectFolderName = useMemo(() => {
    if (!draftProject?.path) {
      return draftProject?.name ?? '';
    }
    const segments = draftProject.path.split(/[\\/]+/).filter(Boolean);
    return segments.at(-1) ?? draftProject.name;
  }, [draftProject?.name, draftProject?.path]);
  const title = draftProjectFolderName
    ? `我们应该在 ${draftProjectFolderName} 中构建什么？`
    : '我们应该做什么？';
  const placeholder = useMemo(() => {
    const label = selectedAgent?.label ?? 'Claude Code';
    return `给 ${label} 发送第一条任务指令... (@ 引用文件, / 查看命令)`;
  }, [selectedAgent]);

  useEffect(() => {
    if (draftProject?.path) {
      setProjectPath(draftProject.path);
      loadFileTree(draftProject.path);
    } else {
      setProjectPath(null);
      usePreviewStore.setState({ treeRoot: null, treeRootPath: null });
    }
  }, [draftProject?.path, loadFileTree, setProjectPath]);

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
      setSelectedProviderId(null);
      setSelectedModel(null);
      return;
    }
    setSelectedProviderId(active.id);
    setSelectedModel(getProfilePrimaryModel(active) || null);
  }, [activeProfileId, availableProfiles, isProfileAgent, selectedAgentKind, setSelectedModel, setSelectedProviderId]);

  const handleSend = async (input: AgentInputPayload | string) => {
    if (!hasUsableProfile) {
      return;
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

      await onSubmit({ text: renderCommandPrompt(command, args) });
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
              disabledMessage={profileRequiredMessage}
              modelSelector={(
                <CodeMuxModelSelector
                  value={effectiveModel}
                  models={providerModels}
                  onChange={setSelectedModel}
                  providers={availableProviders}
                  providerId={selectedProvider?.id ?? null}
                  onProviderChange={(profileId, nextModel) => {
                    if (!isProfileAgent) return;
                    void activateAgentProfile(selectedAgentKind, profileId)
                      .then(() => {
                        const selectedProfile = availableProfiles.find((profile) => profile.id === profileId);
                        setSelectedProviderId(profileId);
                        setSelectedModel(getProfilePrimaryModel(selectedProfile) || nextModel || null);
                      })
                      .catch((error) => {
                        useAgentStore.setState((state) => ({
                          error: { ...state.error, 'new-session-draft': String(error) },
                        }));
                      });
                  }}
                  reasoningEffort={selectedReasoningEffort}
                  onReasoningEffortChange={setSelectedReasoningEffort}
                  getDisplayName={formatSelectedProviderModel}
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
