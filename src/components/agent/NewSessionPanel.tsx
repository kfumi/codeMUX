import { useEffect, useMemo, useState } from 'react';

import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { findCommand, renderCommandPrompt } from '../../lib/slashCommands';
import { getPrimaryProviderModel, getProviderModelList } from '../../lib/providerModels';
import { agentApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import { AgentSelector } from './AgentSelector';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
import { formatModelDisplayName } from './modelDisplay';

interface NewSessionPanelProps {
  onSubmit: (message: string) => Promise<void> | void;
}

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const {
    selectedAgentKind,
    selectedModel,
    selectedReasoningEffort,
    setSelectedAgentKind,
    setSelectedModel,
    setSelectedReasoningEffort,
    draftProjectId,
  } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const activeProvider = useSettingsStore((s) => s.getActiveProvider());
  const config = useSettingsStore((s) => s.config);
  const getActiveProvider = useSettingsStore((s) => s.getActiveProvider);
  const { loadFileTree, setProjectPath } = usePreviewStore();
  const clearEvents = useAgentStore((state) => state.clearEvents);
  const [codexPlanMode, setCodexPlanMode] = useState(false);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const providerModels = useMemo(() => getProviderModelList(activeProvider), [activeProvider]);
  const effectiveModel = selectedModel || getPrimaryProviderModel(activeProvider);
  const formatSelectedProviderModel = useMemo(() => (
    (item: string) => formatModelDisplayName({
      model: item,
      agentKind: selectedAgentKind,
      usesLargeContext: activeProvider?.context_1m,
    })
  ), [activeProvider?.context_1m, selectedAgentKind]);
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

  const handleSend = async (content: string) => {
    const planCommand = findCommand('plan', 'codex');
    await onSubmit(
      selectedAgentKind === 'codex' && codexPlanMode && planCommand
        ? renderCommandPrompt(planCommand, content)
        : content,
    );
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
        getCostInfo: () => '新对话还没有费用信息',
      };
      await command.action(context, args);
      return;
    }

    if (command.handler === 'prompt' && command.prompt) {
      if (selectedAgentKind === 'codex' && command.name === 'plan') {
        setCodexPlanMode(true);
        if (!args) {
          return;
        }
      }

      await onSubmit(renderCommandPrompt(command, args));
    }
  };

  return (
    <div className="flex flex-1 overflow-auto bg-[hsl(var(--background))] transition-[background] duration-300">
      <CodeMuxAssistantRuntimeProvider
        sessionId="new-session-draft"
        agentKind={selectedAgentKind}
        onSend={handleSend}
        onCommand={handleCommand}
      >
        <div className="mx-auto flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[360ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
            <div className="mb-10 flex items-center justify-center gap-4">
              <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} />
              <h1 className="text-center text-[26px] font-semibold leading-tight text-foreground sm:text-[30px]">
                {title}
              </h1>
            </div>

            <CodeMuxComposer
              sessionId="new-session-draft"
              agentKind={selectedAgentKind}
              projectPath={draftProject?.path}
              placeholder={placeholder}
              modelSelector={(
                <CodeMuxModelSelector
                  value={effectiveModel}
                  models={providerModels}
                  onChange={setSelectedModel}
                  reasoningEffort={selectedReasoningEffort}
                  onReasoningEffortChange={setSelectedReasoningEffort}
                  getDisplayName={formatSelectedProviderModel}
                />
              )}
              activeCommandMode={selectedAgentKind === 'codex' && codexPlanMode ? { id: 'plan', label: '计划' } : null}
              onClearCommandMode={() => setCodexPlanMode(false)}
            />

          </div>
        </div>
      </CodeMuxAssistantRuntimeProvider>
    </div>
  );
}
