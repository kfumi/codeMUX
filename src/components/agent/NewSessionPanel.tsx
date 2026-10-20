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
import { isOpenCodeFreeProviderId } from '../../hooks/useAgentModels';
import { useCatalogContextWindow } from '../../hooks/useCatalogContextWindow';
import { isProviderAgent } from '../../lib/scheduledTaskDefaults';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentInputPayload } from '../../types/agentInput';
import { AgentSelector } from './AgentSelector';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { AgentModelSelector } from './AgentModelSelector';
import { getProfileModelContextWindow } from './modelDisplay';
import { DraftWorkspaceToolbar } from './DraftWorkspaceToolbar';
import { resolveDraftProjectPath } from '../../lib/sessionCwd';

interface NewSessionPanelProps {
  onSubmit: (input: AgentInputPayload) => Promise<void> | void;
}

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const checkingRuntimeRef = useRef(false);
  // hasUserSelectedModel: distinguish user explicit choice vs auto follow-config.
  // Cold start free-model catalog arrives async; persisting fallback models[0] would shadow configured default forever.
  const hasUserSelectedModelRef = useRef(false);
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
  const { models, isLoading: areModelsLoading, freePending } = useAgentModels(
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
  const configuredDefaultModelId = configuredAgentModel?.default_model?.trim() || null;
  const configuredDefaultProviderId = configuredAgentModel?.default_provider_id ?? null;
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
  const isFreeSelection = selectedAgentKind === 'opencode'
    && isOpenCodeFreeProviderId(effectiveProviderId);
  // 免费模型没有 ModelProvider 记录，窗口只能从目录取；查不到就不显示分母。
  const freeCatalogContextWindow = useCatalogContextWindow(
    isFreeSelection ? effectiveModel : null,
    'opencode',
  );
  const configuredContextWindow = selectedAgentKind === 'codex' || selectedAgentKind === 'opencode' || selectedAgentKind === 'pi'
    ? (isFreeSelection
      ? freeCatalogContextWindow
      : getProfileModelContextWindow(
        modelProviders.find((provider) => provider.id === effectiveProviderId) ?? null,
        effectiveModel,
      ))
    : null;
  // 配置了默认值但免费目录还在途：先挂起发送，选择器显示加载中；目录回来后首屏即默认值，
  // 避免先闪列表第一个、用户在窗口期内发出跑错模型。无配置时不等待，行为与之前一致。
  const configuredMatched = (!configuredDefaultModelId && !configuredDefaultProviderId)
    || (!!preferredModel
      && (!configuredDefaultModelId || preferredModel.modelId === configuredDefaultModelId)
      && (!configuredDefaultProviderId || preferredModel.providerId === configuredDefaultProviderId));
  const waitingForConfiguredModel = usesProviderModel && !configuredMatched && freePending;
  const hasUsableProvider = !usesProviderModel
    || Boolean(effectiveModel && effectiveProviderId && !areModelsLoading && !waitingForConfiguredModel);

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

  // Switch agent/new draft -> follow config again, wait for sync effect to refill.
  useEffect(() => {
    hasUserSelectedModelRef.current = false;
  }, [selectedAgentKind, draftRevision]);

  useEffect(() => {
    if (!usesProviderModel) return;
    // Model list not ready (cold start config missing, free catalog pending): keep waiting.
    // Do not clear user choice, do not persist fallback into store.
    if (!preferredModel) return;
    if (hasUserSelectedModelRef.current) {
      // User chose explicitly: only fall back to config when choice is invalid now.
      const stillValid = selectedModel && models.some((model) => model.modelId === selectedModel && (
        !selectedProviderId || model.providerId === selectedProviderId
      ));
      if (stillValid) return;
      hasUserSelectedModelRef.current = false;
      setSelectedModel(null);
      setSelectedProviderId(null);
      return;
    }
    // No user choice: follow agent config default model.
    // If configured default exists but is not in current list yet (opencode free catalog async),
    // do NOT persist fallback models[0]; otherwise selectedModel shadows configured default forever
    // (first new chat after launch hits it, second works because free cache is warm).
    if (configuredDefaultModelId || configuredDefaultProviderId) {
      const matchesConfigured = (!configuredDefaultModelId || preferredModel.modelId === configuredDefaultModelId)
        && (!configuredDefaultProviderId || preferredModel.providerId === configuredDefaultProviderId);
      if (!matchesConfigured) return;
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
    models,
    selectedModel,
    selectedProviderId,
    configuredDefaultModelId,
    configuredDefaultProviderId,
    setSelectedModel,
    setSelectedProviderId,
  ]);

  const handleModelChange = (modelId: string, providerId: string) => {
    hasUserSelectedModelRef.current = true;
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
    if (usesProviderModel) {
      if (!hasUserSelectedModelRef.current) {
        // User sends before free catalog arrives with store still null: use configured default
        // (free model id is valid for daemon too) instead of effective fallback (models[0]),
        // otherwise the first message runs with the wrong model.
        const targetModel = configuredDefaultModelId || effectiveModel || null;
        const targetProvider = configuredDefaultProviderId ?? effectiveProviderId ?? null;
        if (targetModel && targetModel !== selectedModel) {
          setSelectedModel(targetModel);
        }
        if (targetProvider && targetProvider !== selectedProviderId) {
          setSelectedProviderId(targetProvider);
        }
      } else if (preferredModel) {
        if (effectiveModel !== selectedModel) {
          setSelectedModel(effectiveModel);
        }
        if (effectiveProviderId && effectiveProviderId !== selectedProviderId) {
          setSelectedProviderId(effectiveProviderId);
        }
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
        {/*
          首页构图对齐 Codex：问候区占满上半屏居中，composer 贴底。

          整页的列宽、水平内边距与底部间距**与真实对话页逐值一致** —— `--content-width` /
          px-5 / pb-3 就是 CodeMuxThread 里 thread-content-shell 与 ViewportFooter 用的
          同一组值。这样点发送后会话页接手时，composer 的宽度与离底高度不动，用户看到的
          只是消息从它上方长出来。上一版列宽是 max-w-2xl(42rem)、底部 py-10，发送瞬间
          输入框会跳宽跳位。
        */}
        <div
          className="mx-auto flex min-h-full w-full flex-col px-5 pb-3 pt-4"
          style={{ maxWidth: 'var(--content-width, 52rem)' }}
        >
          <div className="flex flex-1 flex-col items-center justify-center gap-4 animate-in fade-in fill-mode-both duration-slow ease-motion-out">
            <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} variant="hero" />
            <h1 className="text-center text-ui-heading-md font-semibold leading-tight text-foreground sm:text-ui-heading-lg">
              {title}
            </h1>
            {/* 冷启动模型目录在途时 hasUsableProvider 会短暂为 false，无条件渲染这行
                会让它「闪一下」；等目录落定、确认没有可用供应商时再给提示。 */}
            {!hasUsableProvider && usesProviderModel && !areModelsLoading && !waitingForConfiguredModel && (
              <p className="text-center text-sm text-muted-foreground">
                请先在设置 → 模型配置中配置并启用可用的模型供应商（需 API Key 与匹配协议端点）。
              </p>
            )}
          </div>

          {/*
            composer 整块贴页面底部，入场从下方滑入。

            上下文条（草稿工作区三件：项目 / 工作树 / 分支）是**发送框顶部贴着的那
            一条**（Codex 的 composer rail）：与输入框同一个 flex 列、中间不留间距，
            左右各内缩一个输入框圆角、只圆上面两角 —— 于是它读作输入框伸出来的一条
            「上沿」，而不是浮在旁边的一个独立小框。间距全部由 rail 自己的内边距表达，
            这里不再加任何 margin。见 `DraftWorkspaceToolbar` 顶部注释与工单 06。
          */}
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-slow ease-motion-out">
            <div className="flex flex-col">
              <DraftWorkspaceToolbar />
              <CodeMuxComposer
              key={draftRevision}
              sessionId={NEW_SESSION_DRAFT_SESSION_ID}
              agentKind={selectedAgentKind}
              projectPath={draftProjectPath}
              projectSkills={projectSkills}
              configuredContextWindow={configuredContextWindow}
              assumeDefaultContextWindow={!isFreeSelection}
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
              modelSelector={waitingForConfiguredModel ? (
                <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ui-caption text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-border border-t-muted-foreground motion-reduce:animate-none"
                  />
                  模型加载中…
                </span>
              ) : (
                <AgentModelSelector
                  agentKind={selectedAgentKind}
                  providers={modelProviders}
                  activeProviderId={effectiveProviderId}
                  value={effectiveModel}
                  onChange={handleModelChange}
                  reasoningEffort={selectedReasoningEffort}
                  onReasoningEffortChange={setSelectedReasoningEffort}
                  // This is the same send box as AgentPanel, just with no active
                  // session yet (the cold-start home page), so it must match.
                  effortControl="slider"
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
        </div>
      </CodeMuxAssistantRuntimeProvider>
    </div>
  );
}
