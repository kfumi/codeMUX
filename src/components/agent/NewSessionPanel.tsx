import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { renderCommandPrompt } from '../../lib/slashCommands';
import { serializePermissionConfig } from '../../lib/agentPermissions';
import { getActiveModelProvider, isProviderUsable } from '../../lib/modelProviders';
import { getProviderPrimaryModel } from '../../lib/agentProfileSelector';
import { agentApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAgentModels } from '../../hooks/useAgentModels';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentInputPayload } from '../../types/agentInput';
import { AgentSelector } from './AgentSelector';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { AgentModelSelector } from './AgentModelSelector';

interface NewSessionPanelProps {
  onSubmit: (input: AgentInputPayload) => Promise<void> | void;
}

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const checkingRuntimeRef = useRef(false);
  const {
    selectedAgentKind,
    selectedModel,
    selectedReasoningEffort,
    selectedPermissionConfig,
    selectedPlanMode,
    draftRevision,
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
  const isProviderAgent = selectedAgentKind === 'claude_code' || selectedAgentKind === 'codex' || selectedAgentKind === 'opencode';
  const modelProviders = config?.model_providers ?? [];
  const activeProviderId = config?.active_provider_id ?? null;
  const activeProvider = useMemo(
    () => getActiveModelProvider(modelProviders, activeProviderId),
    [activeProviderId, modelProviders],
  );
  const { models, isLoading: areModelsLoading } = useAgentModels(selectedAgentKind, activeProvider, activeProviderId);
  const effectiveModel = selectedModel || getProviderPrimaryModel(activeProvider) || models[0]?.id || '';
  const selectedModelIsAvailable = !selectedModel || models.some((model) => model.id === selectedModel);
  const hasUsableProvider = !isProviderAgent
    || Boolean(
      activeProvider
        && isProviderUsable(activeProvider, selectedAgentKind)
        && effectiveModel
        && !areModelsLoading
        && selectedModelIsAvailable,
    );

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
    draftRevision,
    selectedAgentKind,
    setSelectedPermissionConfig,
    setSelectedPlanMode,
  ]);

  useEffect(() => {
    if (!isProviderAgent) return;
    if (!activeProvider || !isProviderUsable(activeProvider, selectedAgentKind)) {
      setSelectedModel(null);
      return;
    }
    setSelectedModel(getProviderPrimaryModel(activeProvider) || null);
  }, [activeProvider, isProviderAgent, selectedAgentKind, setSelectedModel]);

  const handleSend = async (input: AgentInputPayload | string) => {
    const currentStore = useNewSessionStore.getState();
    if (checkingRuntimeRef.current) {
      return;
    }
    if (currentStore.selectedAgentKind !== selectedAgentKind || !hasUsableProvider) {
      return;
    }
    if (isProviderAgent && effectiveModel !== selectedModel) {
      setSelectedModel(effectiveModel);
    }
    const payload = typeof input === 'string' ? { text: input } : input;
    checkingRuntimeRef.current = true;
    setIsCheckingRuntime(true);
    try {
      await onSubmit(payload);
    } finally {
      checkingRuntimeRef.current = false;
      setIsCheckingRuntime(false);
    }
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
        sendDisabled={!hasUsableProvider || isCheckingRuntime}
      >
        <div className="mx-auto flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[360ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
            <div className="mb-10 flex flex-col items-center gap-4">
              <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} variant="hero" />
              <h1 className="text-center text-ui-heading-md font-semibold leading-tight text-foreground sm:text-ui-heading-lg">
                {title}
              </h1>
              {!hasUsableProvider && isProviderAgent && (
                <p className="text-center text-sm text-muted-foreground">
                  请先在设置 → 供应商配置中添加并激活可用的模型供应商（需 API Key 与匹配协议端点）。
                </p>
              )}
            </div>

            <CodeMuxComposer
              sessionId="new-session-draft"
              agentKind={selectedAgentKind}
              projectPath={draftProject?.path}
              placeholder={placeholder}
              disabled={!hasUsableProvider || isCheckingRuntime}
              loading={isCheckingRuntime}
              modelSelector={(
                <AgentModelSelector
                  agentKind={selectedAgentKind}
                  activeProvider={activeProvider}
                  activeProviderId={activeProviderId}
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
            />
          </div>
        </div>
      </CodeMuxAssistantRuntimeProvider>
    </div>
  );
}
