import { Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { toast, Toaster } from 'sonner';

import { ErrorBoundary } from './components/ErrorBoundary';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { useAgentNotifications } from './hooks/useAgentNotifications';
import { useTheme } from './hooks/useTheme';
import { createLogger, serializeError } from './lib/logger';
import type { AgentInputPayload } from './types/agentInput';
import { getStoredAgentCwd, resolveSessionCwd } from './lib/sessionCwd';
import { registerSkillCommands } from './lib/slashCommands';
import { serializePermissionConfig } from './lib/agentPermissions';
import { appApi, sessionApi } from './lib/tauri';
import { useAgentStore } from './stores/agentStore';
import './stores/appearanceStore';
import { useNewSessionStore, NEW_SESSION_DRAFT_SESSION_ID } from './stores/newSessionStore';
import { useProjectStore } from './stores/projectStore';
import { useSessionStore } from './stores/sessionStore';
import { useSidePanelStore } from './stores/sidePanelStore';
import { useSettingsStore } from './stores/settingsStore';
import { useSkillStore } from './stores/skillStore';
import { useNavigationStore, type NavigationLocation, type SidePanelNavigationState } from './stores/navigationStore';
import { UpdaterProvider } from './features/update/UpdaterProvider';
import { UpdateEntry } from './features/update/components/UpdateEntry';
import type { TodoItem } from './types/agent';
import type { SettingsTab } from './components/settings/SettingsDialog';

const logger = createLogger('App');
const AgentPanel = lazy(async () => ({ default: (await import('./components/agent/AgentPanel')).AgentPanel }));
const NewSessionPanel = lazy(async () => ({ default: (await import('./components/agent/NewSessionPanel')).NewSessionPanel }));
const SettingsSidebar = lazy(async () => ({ default: (await import('./components/settings/SettingsDialog')).SettingsSidebar }));
const SettingsContent = lazy(async () => ({ default: (await import('./components/settings/SettingsDialog')).SettingsContent }));
const SessionHeader = lazy(async () => ({ default: (await import('./components/layout/SessionHeader')).SessionHeader }));
const PerfOverlay = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('./components/dev/PerfOverlay')).PerfOverlay }))
  : null;
const EMPTY_TODOS: TodoItem[] = [];

const panelFallback = (
  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">
    加载中...
  </div>
);

function getSidePanelNavigation(scopeId: string): SidePanelNavigationState {
  const state = useSidePanelStore.getState();
  if (state.activeScopeId === scopeId) {
    return {
      scopeId,
      isOpen: state.isOpen,
      activeTabId: state.activeTabId,
    };
  }

  const snapshot = state.scopes[scopeId];
  return {
    scopeId,
    isOpen: snapshot?.isOpen ?? false,
    activeTabId: snapshot?.activeTabId ?? null,
  };
}

function App() {
  const createSession = useSessionStore((state) => state.createSession);
  const deleteSession = useSessionStore((state) => state.deleteSession);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const startQuery = useAgentStore((state) => state.startQuery);
  const activeTodos = useAgentStore((state) => activeSessionId ? state.todos[activeSessionId] ?? EMPTY_TODOS : EMPTY_TODOS);
  const fetchConfig = useSettingsStore((state) => state.fetchConfig);
  const projects = useProjectStore((state) => state.projects);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const isDraftOpen = useNewSessionStore((state) => state.isDraftOpen);
  const draftProjectId = useNewSessionStore((state) => state.draftProjectId);
  const openDraft = useNewSessionStore((state) => state.openDraft);
  const closeDraft = useNewSessionStore((state) => state.closeDraft);
  const navigationLocation = useNavigationStore((state) => state.current);
  const canGoBack = useNavigationStore((state) => state.backStack.length > 0);
  const canGoForward = useNavigationStore((state) => state.forwardStack.length > 0);
  const navigate = useNavigationStore((state) => state.navigate);
  const goBack = useNavigationStore((state) => state.goBack);
  const goForward = useNavigationStore((state) => state.goForward);
  const setRestoring = useNavigationStore((state) => state.setRestoring);
  const activeView = navigationLocation.view;
  const settingsTab = navigationLocation.settingsTab;
  const [perfOverlayVisible, setPerfOverlayVisible] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setPerfOverlayVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
  const activeProjectId = activeSession?.project_id ?? draftProjectId ?? null;
  const sidePanelProjectPath = activeProjectId ? projects.find((project) => project.id === activeProjectId)?.path ?? null : null;
  const sidePanelScopeId = activeSessionId ?? (isDraftOpen ? `draft:${draftProjectId ?? 'none'}` : 'home');

  useTheme();
  useAgentNotifications();

  const applyNavigationLocation = useCallback((location: NavigationLocation) => {
    setRestoring(true);
    setActiveSession(location.activeSessionId);
    setActiveProject(location.activeProjectId);

    const currentDraft = useNewSessionStore.getState();
    if (location.isDraftOpen) {
      if (!currentDraft.isDraftOpen || currentDraft.draftProjectId !== location.draftProjectId) {
        openDraft(location.draftProjectId);
      }
    } else if (currentDraft.isDraftOpen) {
      closeDraft();
    }

    useSidePanelStore.getState().restoreNavigation(location.sidePanel);
    setRestoring(false);
  }, [closeDraft, openDraft, setActiveProject, setActiveSession, setRestoring]);

  const commitNavigation = useCallback((location: NavigationLocation) => {
    navigate(location);
    applyNavigationLocation(location);
  }, [applyNavigationLocation, navigate]);

  const handleNavigateHome = useCallback(() => {
    commitNavigation({
      ...navigationLocation,
      view: 'app',
      activeSessionId: null,
      activeProjectId: null,
      draftProjectId: null,
      isDraftOpen: false,
      sidePanel: getSidePanelNavigation('home'),
    });
  }, [commitNavigation, navigationLocation]);

  const handleReturnToApp = useCallback(() => {
    commitNavigation({
      ...navigationLocation,
      view: 'app',
    });
  }, [commitNavigation, navigationLocation]);

  const handleSelectSession = useCallback((sessionId: string, projectId: string | null) => {
    commitNavigation({
      ...navigationLocation,
      view: 'app',
      activeSessionId: sessionId,
      activeProjectId: projectId,
      draftProjectId: null,
      isDraftOpen: false,
      sidePanel: getSidePanelNavigation(sessionId),
    });
  }, [commitNavigation, navigationLocation]);

  const handleOpenSettings = useCallback(() => {
    commitNavigation({
      ...navigationLocation,
      view: 'settings',
    });
  }, [commitNavigation, navigationLocation]);

  const handleSettingsTabChange = useCallback((tab: SettingsTab) => {
    commitNavigation({
      ...navigationLocation,
      view: 'settings',
      settingsTab: tab,
    });
  }, [commitNavigation, navigationLocation]);

  const handleBack = useCallback(() => {
    const location = goBack();
    if (location) applyNavigationLocation(location);
  }, [applyNavigationLocation, goBack]);

  const handleForward = useCallback(() => {
    const location = goForward();
    if (location) applyNavigationLocation(location);
  }, [applyNavigationLocation, goForward]);

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
            diskPath: skill.disk_path,
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
    setActiveSession(null);
    setActiveProject(projectId ?? null);
    const newSessionState = useNewSessionStore.getState();
    const settingsConfig = useSettingsStore.getState().config;
    const configuredPermissionConfig = newSessionState.selectedAgentKind === 'codex'
      ? settingsConfig?.agent_configs.codex?.permission_config
      : settingsConfig?.agent_configs.claude_code.permission_config;
    openDraft(
      projectId,
      serializePermissionConfig(newSessionState.selectedAgentKind, configuredPermissionConfig),
    );
    const draftScopeId = `draft:${projectId ?? 'none'}`;
    commitNavigation({
      ...navigationLocation,
      view: 'app',
      activeSessionId: null,
      activeProjectId: projectId ?? null,
      draftProjectId: projectId ?? null,
      isDraftOpen: true,
      sidePanel: getSidePanelNavigation(draftScopeId),
    });
  };

  const handleStartNewSession = async (input: AgentInputPayload) => {
    const {
      selectedAgentKind,
      selectedModel,
      selectedProviderId,
      selectedReasoningEffort,
      selectedPermissionConfig,
      selectedPlanMode,
      draftProjectId,
    } = useNewSessionStore.getState();
    const cwd = resolveSessionCwd(projects, draftProjectId, getStoredAgentCwd());

    let createdSessionId: string | null = null;

    try {
      if (selectedAgentKind === 'claude_code' || selectedAgentKind === 'codex' || selectedAgentKind === 'opencode') {
        const runtimeCheck = await appApi.checkManagedRuntimes();
        const runtime = runtimeCheck.runtimes.find((entry) => entry.provider === selectedAgentKind);
        if (!runtime || (runtime.status !== 'ready' && runtime.status !== 'outdated')) {
          throw new Error(runtime?.message ?? `${runtime?.label ?? selectedAgentKind} Runtime 未安装或不可用，请先在设置中安装`);
        }
      }

      const session = await createSession(
        '新对话',
        selectedAgentKind,
        'agent',
        draftProjectId ?? undefined,
        selectedPermissionConfig,
        selectedPlanMode,
        selectedModel ?? undefined,
      );
      createdSessionId = session.id;

      if (selectedProviderId && selectedModel) {
        await sessionApi.updateProvider(
          session.id,
          selectedProviderId,
          selectedModel,
          selectedReasoningEffort,
        );
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((entry) => entry.id === session.id
            ? {
                ...entry,
                provider_id: selectedProviderId,
                model: selectedModel,
                reasoning_effort: selectedReasoningEffort,
              }
            : entry),
        }));
      }
      await sessionApi.updateReasoningEffort(session.id, selectedReasoningEffort);
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((entry) => entry.id === session.id
          ? { ...entry, reasoning_effort: selectedReasoningEffort }
          : entry),
      }));

      await startQuery(session.id, input.text, cwd, selectedReasoningEffort, undefined, input, selectedModel ?? undefined);
      useAgentStore.getState().consumeComposerDraft(NEW_SESSION_DRAFT_SESSION_ID);
      closeDraft();
      const currentNavigation = useNavigationStore.getState().current;
      commitNavigation({
        ...currentNavigation,
        view: 'app',
        activeSessionId: session.id,
        activeProjectId: draftProjectId ?? null,
        draftProjectId: null,
        isDraftOpen: false,
        sidePanel: getSidePanelNavigation(session.id),
      });
    } catch (error) {
      if (createdSessionId) {
        await deleteSession(createdSessionId);
      }
      logger.error('Failed to start a new session from empty state', undefined, serializeError(error));
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <UpdaterProvider>
      <TooltipProvider>
        {PerfOverlay && perfOverlayVisible && (
          <Suspense fallback={null}>
            <PerfOverlay />
          </Suspense>
        )}
        <MainLayout
          sidebar={activeView === 'settings' ? (
            <Suspense fallback={<div className="h-full" />}>
              <SettingsSidebar
                activeTab={settingsTab}
                onTabChange={handleSettingsTabChange}
                onBack={handleReturnToApp}
              />
            </Suspense>
          ) : (
            <Sidebar
              onNewSession={() => handleNewSession()}
              onNewSessionInProject={(projectId) => handleNewSession(projectId)}
              onNavigateHome={handleNavigateHome}
              onSelectSession={handleSelectSession}
              onOpenSettings={handleOpenSettings}
            />
          )}
          sidebarAccessory={activeView === 'settings' ? undefined : <UpdateEntry />}
          sidePanelAvailable={activeView === 'app'}
          sidePanelProjectPath={sidePanelProjectPath}
          sidePanelScopeId={sidePanelScopeId}
          projectOpenPath={activeView === 'app' && activeSessionId ? sidePanelProjectPath : null}
          todos={activeView === 'app' ? activeTodos : EMPTY_TODOS}
          titleBarNavigation={{
            canGoBack,
            canGoForward,
            onBack: handleBack,
            onForward: handleForward,
          }}
          headerContent={activeView === 'app' && activeSessionId ? (
            <Suspense fallback={null}>
              <SessionHeader sessionId={activeSessionId} />
            </Suspense>
          ) : undefined}
        >
          <ErrorBoundary>
            {activeView === 'settings' ? (
              <Suspense fallback={panelFallback}>
              <SettingsContent activeTab={settingsTab} onTabChange={handleSettingsTabChange} />
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
                    <h2 className="text-ui-title font-semibold text-foreground/84">开始新对话</h2>
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
