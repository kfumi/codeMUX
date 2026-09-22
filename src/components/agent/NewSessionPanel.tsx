import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { renderCommandInput } from '../../lib/slashCommands';
import { serializePermissionConfig } from '../../lib/agentPermissions';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { useAgentStore } from '../../stores/agentStore';
import { useNewSessionStore, NEW_SESSION_DRAFT_SESSION_ID } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { projectSkillCacheKey, useProjectSkillStore } from '@/stores/projectSkillStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAgentModels } from '../../hooks/useAgentModels';
import { isProviderAgent } from '../../lib/scheduledTaskDefaults';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentInputPayload } from '../../types/agentInput';
import { AgentSelector } from './AgentSelector';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { AgentSetupChecklist } from './AgentSetupChecklist';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { AgentModelSelector } from './AgentModelSelector';
import { getProfileModelContextWindow } from './modelDisplay';
import { DraftWorkspaceToolbar } from './DraftWorkspaceToolbar';
import { resolveDraftProjectPath } from '../../lib/sessionCwd';

interface NewSessionPanelProps {
  onSubmit: (input: AgentInputPayload) => Promise<void> | void;
}

const STARTER_PROMPTS: Record<string, string[]> = {
  claude_code: ['先检查项目结构', '帮我定位一个问题', '制定实现计划'],
  codex: ['审查当前改动', '运行测试并修复失败', '分析这个项目的入口'],
  opencode: ['先了解项目结构', '实现一个小功能', '检查最近的代码改动'],
};

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const checkingRuntimeRef = useRef(false);
  const {
    selectedAgentKind,
    selectedModel,
    selectedProviderId,
    selectedReasoningEffort,
    selectedPermissionConfig,
    selectedPlanMode,
    draftRevision,
    setSelectedAgentKind,
    setSelectedModel,
    setSelectedProviderId,
    setSelectedReasoningEffort,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
    draftProjectId,
    draftWorkspace,
  } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((s) => s.config);
  const getActiveProvider = useSettingsStore((s) => s.getActiveProvider);
  const { setProjectPath } = usePreviewStore();
  const clearEvents = useAgentStore((state) => state.clearEvents);
  const loadProjectSkills = useProjectSkillStore((state) => state.load);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const usesProviderModel = isProviderAgent(selectedAgentKind);
  const modelProviders = config?.model_providers ?? [];
  const activeProviderId = config?.active_provider_id ?? null;
  const { models, isLoading: areModelsLoading } = useAgentModels(
    selectedAgentKind,
    modelProviders,
    selectedProviderId ?? activeProviderId,
  );
  const configuredAgentModel = usesProviderModel
    ? config?.agent_configs[selectedAgentKind] as {
        default_provider_id?: string | null;
        default_model?: string;
      } | undefined
    : undefined;
  const preferredProviderId = selectedProviderId
    ?? configuredAgentModel?.default_provider_id
    ?? activeProviderId;
  const preferredModelId = selectedModel ?? configuredAgentModel?.default_model;
  const preferredModel = useMemo(() => {
    if (preferredModelId && models.some((model) => model.modelId === preferredModelId && (
      !preferredProviderId || model.providerId === preferredProviderId
    ))) {
      return models.find((model) =>
        model.modelId === preferredModelId
        && (!preferredProviderId || model.providerId === preferredProviderId),
      ) ?? null;
    }
    if (preferredProviderId) {
      return models.find((model) => model.providerId === preferredProviderId) ?? models[0] ?? null;
    }
    return models[0] ?? null;
  }, [models, preferredModelId, preferredProviderId]);
  const effectiveModel = preferredModel?.modelId || '';
  const effectiveProviderId = preferredModel?.providerId || preferredProviderId;
  const configuredContextWindow = selectedAgentKind === 'codex' || selectedAgentKind === 'opencode' || selectedAgentKind === 'pi'
    ? getProfileModelContextWindow(
      modelProviders.find((provider) => provider.id === effectiveProviderId) ?? null,
      effectiveModel,
    )
    : null;
  const hasUsableProvider = !usesProviderModel
    || Boolean(effectiveModel && effectiveProviderId && !areModelsLoading);

  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );
  const draftProjectPath = useMemo(
    () => resolveDraftProjectPath(projects, draftProjectId, draftWorkspace),
    [draftProjectId, draftWorkspace, projects],
  );
  const projectName = draftProject?.name ?? '';
  const projectSkillEntry = useProjectSkillStore((state) => (
    draftProjectPath
      ? state.entries[projectSkillCacheKey(draftProjectPath, selectedAgentKind)]
      : undefined
  ));
  const projectSkills = projectSkillEntry?.skills ?? [];
  const title = projectName
    ? `我们应该在 ${projectName} 中构建什么？`
    : '我们应该做什么？';
  const placeholder = useMemo(() => {
    const label = selectedAgent?.label ?? 'Claude Code';
    return `给 ${label} 发送第一条任务指令... (@ 引用文件, / 查看命令)`;
  }, [selectedAgent]);

  useEffect(() => {
    if (draftProjectPath) {
      setProjectPath(draftProjectPath);
    } else {
      setProjectPath(null);
      usePreviewStore.setState({ treeRoot: null, treeRootPath: null });
    }
  }, [draftProjectPath, setProjectPath]);

  useEffect(() => {
    void loadProjectSkills(draftProjectPath, selectedAgentKind);
  }, [draftProjectPath, loadProjectSkills, selectedAgentKind]);

  useEffect(() => {
    const configured = selectedAgentKind === 'codex'
      ? config?.agent_configs.codex?.permission_config
      : selectedAgentKind === 'opencode'
        ? config?.agent_configs.opencode?.permission_config
        : selectedAgentKind === 'pi'
          ? config?.agent_configs.pi?.permission_config
          : config?.agent_configs.claude_code.permission_config;
    setSelectedPermissionConfig(serializePermissionConfig(selectedAgentKind, configured));
    setSelectedPlanMode('off');
  }, [
    config?.agent_configs.claude_code.permission_config,
    config?.agent_configs.codex?.permission_config,
    config?.agent_configs.opencode?.permission_config,
    config?.agent_configs.pi?.permission_config,
    draftRevision,
    selectedAgentKind,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
  ]);

  useEffect(() => {
    if (!usesProviderModel) return;
    if (!preferredModel) {
      setSelectedModel(null);
      setSelectedProviderId(null);
      return;
    }
    if (
      selectedModel !== preferredModel.modelId
      || selectedProviderId !== preferredModel.providerId
    ) {
      setSelectedModel(preferredModel.modelId);
      setSelectedProviderId(preferredModel.providerId);
    }
  }, [
    usesProviderModel,
    preferredModel,
    selectedModel,
    selectedProviderId,
    setSelectedModel,
    setSelectedProviderId,
  ]);

  const handleModelChange = (modelId: string, providerId: string) => {
    setSelectedModel(modelId);
    setSelectedProviderId(providerId);
  };

  const handleSend = async (input: AgentInputPayload | string) => {
    const currentStore = useNewSessionStore.getState();
    if (checkingRuntimeRef.current) {
      return;
    }
    if (currentStore.selectedAgentKind !== selectedAgentKind || !hasUsableProvider) {
      return;
    }
    if (usesProviderModel && preferredModel) {
      if (effectiveModel !== selectedModel) {
        setSelectedModel(effectiveModel);
      }
      if (effectiveProviderId && effectiveProviderId !== selectedProviderId) {
        setSelectedProviderId(effectiveProviderId);
      }
    }
    const payload = typeof input === 'string' ? { text: input } : input;
    checkingRuntimeRef.current = true;
    setIsCheckingRuntime(true);
    try {
      await onSubmit(payload);
      useAgentStore.getState().consumeComposerDraft(NEW_SESSION_DRAFT_SESSION_ID);
    } finally {
      checkingRuntimeRef.current = false;
      setIsCheckingRuntime(false);
    }
  };

  const handleCommand = async (command: SlashCommand, args: string) => {
    if (command.handler === 'local' && command.action) {
      const context: CommandContext = {
        sessionId: NEW_SESSION_DRAFT_SESSION_ID,
        cwd: draftProjectPath ?? '',
        showInfoDialog: () => {},
        createSession: async () => {},
        clearEvents,
        resetSession: () => { daemonFacade.resetAgentSession(NEW_SESSION_DRAFT_SESSION_ID); },
        deleteClaudeSessionFiles: () => daemonFacade.deleteClaudeSessionFiles(NEW_SESSION_DRAFT_SESSION_ID),
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

      await handleSend({ text: renderCommandInput(command, args, selectedAgentKind) });
    }
  };

  return (
    <div className="flex flex-1 overflow-auto bg-[hsl(var(--background))] transition-[background] duration-slow">
      <CodeMuxAssistantRuntimeProvider
        sessionId={NEW_SESSION_DRAFT_SESSION_ID}
        agentKind={selectedAgentKind}
        projectSkills={projectSkills}
        onSend={handleSend}
        onCommand={handleCommand}
        sendDisabled={!hasUsableProvider || isCheckingRuntime}
      >
        <div className="mx-auto flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both duration-slow ease-motion-out">
            <div className="mb-10 flex flex-col items-center gap-4">
              <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} variant="hero" />
              <h1 className="text-center text-ui-heading-md font-semibold leading-tight text-foreground sm:text-ui-heading-lg">
                {title}
              </h1>
              {!hasUsableProvider && usesProviderModel && (
                <p className="text-center text-sm text-muted-foreground">
                  请先在设置 → 模型配置中配置并启用可用的模型供应商（需 API Key 与匹配协议端点）。
                </p>
              )}
              <AgentSetupChecklist
                agentLabel={selectedAgent?.label ?? '智能体'}
                hasUsableProvider={hasUsableProvider}
                isLoadingModel={areModelsLoading}
                hasModel={Boolean(effectiveModel)}
                hasWorkspace={Boolean(draftProjectPath)}
              />
              <div className="flex flex-wrap justify-center gap-2">
                {(STARTER_PROMPTS[selectedAgentKind] ?? STARTER_PROMPTS.claude_code).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={!hasUsableProvider || isCheckingRuntime}
                    onClick={() => void handleSend({ text: prompt })}
                    className="rounded-full border border-border/55 bg-[hsl(var(--surface-1))]/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/6 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            <DraftWorkspaceToolbar />

            <CodeMuxComposer
              key={draftRevision}
              sessionId={NEW_SESSION_DRAFT_SESSION_ID}
              agentKind={selectedAgentKind}
              projectPath={draftProjectPath}
              projectSkills={projectSkills}
              configuredContextWindow={configuredContextWindow}
              placeholder={placeholder}
              disabled={!hasUsableProvider || isCheckingRuntime}
              loading={isCheckingRuntime}
              planMode={selectedPlanMode}
              onTogglePlanMode={() => {
                setSelectedPlanMode(selectedPlanMode === 'on' ? 'off' : 'on');
              }}
              onActivatePlanMode={() => {
                setSelectedPlanMode('on');
              }}
              modelSelector={(
                <AgentModelSelector
                  agentKind={selectedAgentKind}
                  providers={modelProviders}
                  activeProviderId={effectiveProviderId}
                  value={effectiveModel}
                  onChange={handleModelChange}
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
            />
          </div>
        </div>
      </CodeMuxAssistantRuntimeProvider>
    </div>
  );
}
