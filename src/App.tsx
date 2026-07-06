import { Sparkles } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Toaster } from 'sonner';

import { ErrorBoundary } from './components/ErrorBoundary';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { TodoList } from './components/agent/TodoList';
import { TooltipProvider } from './components/ui/tooltip';
import { resolveAgentProviderConfig } from './lib/agentProvider';
import { useAgentNotifications } from './hooks/useAgentNotifications';
import { useTheme } from './hooks/useTheme';
import { createLogger, serializeError } from './lib/logger';
import type { AgentInputPayload } from './types/agentInput';
import { getStoredAgentCwd, resolveSessionCwd } from './lib/sessionCwd';
import { registerSkillCommands } from './lib/slashCommands';
import { sessionApi } from './lib/tauri';
import { useAgentStore } from './stores/agentStore';
import './stores/appearanceStore';
import { useNewSessionStore } from './stores/newSessionStore';
import { useProjectStore } from './stores/projectStore';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';
import { useSkillStore } from './stores/skillStore';
import { UpdaterProvider } from './features/update/UpdaterProvider';
import { UpdateEntry } from './features/update/components/UpdateEntry';
import type { TodoItem } from './types/agent';

const logger = createLogger('App');
const AgentPanel = lazy(async () => ({ default: (await import('./components/agent/AgentPanel')).AgentPanel }));
const NewSessionPanel = lazy(async () => ({ default: (await import('./components/agent/NewSessionPanel')).NewSessionPanel }));
const SettingsView = lazy(async () => ({ default: (await import('./components/settings/SettingsDialog')).SettingsView }));
const SessionHeader = lazy(async () => ({ default: (await import('./components/layout/SessionHeader')).SessionHeader }));
const EMPTY_TODOS: TodoItem[] = [];

const panelFallback = (
  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">
    加载中...
  </div>
);

function App() {
  const createSession = useSessionStore((state) => state.createSession);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const startQuery = useAgentStore((state) => state.startQuery);
  const activeTodos = useAgentStore((state) => activeSessionId ? state.todos[activeSessionId] ?? EMPTY_TODOS : EMPTY_TODOS);
  const config = useSettingsStore((state) => state.config);
  const fetchConfig = useSettingsStore((state) => state.fetchConfig);
  const projects = useProjectStore((state) => state.projects);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const isDraftOpen = useNewSessionStore((state) => state.isDraftOpen);
  const draftProjectId = useNewSessionStore((state) => state.draftProjectId);
  const openDraft = useNewSessionStore((state) => state.openDraft);
  const closeDraft = useNewSessionStore((state) => state.closeDraft);
  const [activeView, setActiveView] = useState<'app' | 'settings'>('app');

  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
  const activeProjectId = activeSession?.project_id ?? draftProjectId ?? null;
  const sidePanelProjectPath = activeProjectId ? projects.find((project) => project.id === activeProjectId)?.path ?? null : null;
  const sidePanelScopeId = activeSessionId ?? (isDraftOpen ? `draft:${draftProjectId ?? 'none'}` : 'home');

  useTheme();
  useAgentNotifications();

  useEffect(() => {
    fetchConfig().catch((error) => {
      logger.error('Failed to fetch initial config', undefined, serializeError(error));
    });
  }, [fetchConfig]);

  useEffect(() => {
    const skillStore = useSkillStore.getState();
    skillStore
      .syncBuiltins()
      .then(() => skillStore.fetchInstalled())
      .then(() => {
        const skills = useSkillStore.getState().installedSkills;
        registerSkillCommands(
          skills.map((skill) => ({
            name: skill.name,
            description: skill.description || skill.display_name || skill.name,
            apps: skill.apps,
          })),
        );
        logger.info('Skill commands registered', {
          totalSkills: skills.length,
        });
      })
      .catch((error) => {
        logger.error('Failed to initialize skill commands', undefined, serializeError(error));
      });
  }, []);

  useEffect(() => {
    if (activeSessionId && isDraftOpen) {
      closeDraft();
    }
  }, [activeSessionId, closeDraft, isDraftOpen]);

  const handleNewSession = (projectId?: string) => {
    setActiveView('app');
    setActiveSession(null);
    setActiveProject(projectId ?? null);
    openDraft(projectId);
  };

  const handleStartNewSession = async (input: AgentInputPayload) => {
    const {
      selectedAgentKind,
      selectedModel,
      selectedReasoningEffort,
      selectedPermissionConfig,
      selectedPlanMode,
      draftProjectId,
    } = useNewSessionStore.getState();
    const cwd = resolveSessionCwd(projects, draftProjectId, getStoredAgentCwd());
    const { provider, apiKey, baseUrl, model, runtimeModel, codexNeedsProxy } = resolveAgentProviderConfig({
      agentKind: selectedAgentKind,
      config,
      sessionModel: selectedModel,
    });

    try {
      const session = await createSession(
        '新对话',
        selectedAgentKind,
        'agent',
        draftProjectId ?? undefined,
        selectedPermissionConfig,
        selectedPlanMode,
      );

      if (provider?.id && model) {
        sessionApi.updateProvider(session.id, provider.id, model, selectedReasoningEffort).catch(() => {});
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((existingSession) =>
            existingSession.id === session.id
              ? { ...existingSession, provider_id: provider.id, model, reasoning_effort: selectedReasoningEffort }
              : existingSession,
          ),
        }));
      }

      await startQuery(session.id, input.text, cwd, apiKey, baseUrl, runtimeModel, selectedReasoningEffort, codexNeedsProxy, undefined, input);
      closeDraft();
    } catch (error) {
      logger.error('Failed to start a new session from empty state', undefined, serializeError(error));
      throw error;
    }
  };

  return (
    <UpdaterProvider>
      <TooltipProvider>
        <MainLayout
          sidebar={activeView === 'settings' ? undefined : (
            <Sidebar
              onNewSession={() => handleNewSession()}
              onNewSessionInProject={(projectId) => handleNewSession(projectId)}
              onNavigateHome={() => setActiveView('app')}
              onOpenSettings={() => setActiveView('settings')}
            />
          )}
          sidebarAccessory={activeView === 'settings' ? undefined : <UpdateEntry />}
          sidePanelAvailable={activeView === 'app'}
          sidePanelProjectPath={activeView === 'app' ? sidePanelProjectPath : null}
          sidePanelScopeId={activeView === 'app' ? sidePanelScopeId : 'settings'}
          headerContent={activeView === 'app' && activeSessionId ? (
            <Suspense fallback={null}>
              <SessionHeader sessionId={activeSessionId} />
            </Suspense>
          ) : undefined}
          titleBarControls={activeView === 'app' && activeSessionId && activeTodos.length > 0 ? (
            <TodoList todos={activeTodos} dropdownSide="down" align="right" className="mr-1" />
          ) : undefined}
        >
          <ErrorBoundary>
            {activeView === 'settings' ? (
              <Suspense fallback={panelFallback}>
                <SettingsView onBack={() => setActiveView('app')} />
              </Suspense>
            ) : activeSessionId ? (
              <Suspense fallback={panelFallback}>
                <AgentPanel sessionId={activeSessionId} />
              </Suspense>
            ) : isDraftOpen ? (
              <Suspense fallback={panelFallback}>
                <NewSessionPanel onSubmit={handleStartNewSession} />
              </Suspense>
            ) : (
              <div className="flex flex-1 items-center justify-center animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]">
                <div className="max-w-md space-y-5 text-center">
                  <div className="relative inline-flex">
                    <div className="relative flex h-14 w-14 items-center justify-center rounded-xl border border-border/70 bg-muted/35 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)]">
                      <Sparkles className="h-6 w-6 text-[hsl(var(--primary)/0.58)]" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-[15px] font-semibold text-foreground/84">开始新对话</h2>
                    <p className="text-sm leading-relaxed text-foreground/70">
                      在左侧创建对话，或选择一个项目开始编码任务
                    </p>
                  </div>
                </div>
              </div>
            )}
          </ErrorBoundary>
        </MainLayout>
        <Toaster position="top-center" richColors />
      </TooltipProvider>
    </UpdaterProvider>
  );
}

export default App;
