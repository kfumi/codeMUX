import { Sparkles } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Toaster } from 'sonner';

import { ErrorBoundary } from './components/ErrorBoundary';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { resolveAgentProviderConfig } from './lib/agentProvider';
import { useTheme } from './hooks/useTheme';
import { createLogger, serializeError } from './lib/logger';
import { getStoredAgentCwd, resolveSessionCwd } from './lib/sessionCwd';
import { registerSkillCommands } from './lib/slashCommands';
import { sessionApi } from './lib/tauri';
import { useAgentStore } from './stores/agentStore';
import { useNewSessionStore } from './stores/newSessionStore';
import { useProjectStore } from './stores/projectStore';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';
import { useSkillStore } from './stores/skillStore';

const logger = createLogger('App');
const AgentPanel = lazy(async () => ({ default: (await import('./components/agent/AgentPanel')).AgentPanel }));
const NewSessionPanel = lazy(async () => ({ default: (await import('./components/agent/NewSessionPanel')).NewSessionPanel }));
const PreviewPanel = lazy(async () => ({ default: (await import('./components/preview/PreviewPanel')).PreviewPanel }));
const SettingsDialog = lazy(async () => ({ default: (await import('./components/settings/SettingsDialog')).SettingsDialog }));

const panelFallback = (
  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">
    加载中...
  </div>
);

function App() {
  const createSession = useSessionStore((state) => state.createSession);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const startQuery = useAgentStore((state) => state.startQuery);
  const config = useSettingsStore((state) => state.config);
  const fetchConfig = useSettingsStore((state) => state.fetchConfig);
  const projects = useProjectStore((state) => state.projects);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const isDraftOpen = useNewSessionStore((state) => state.isDraftOpen);
  const openDraft = useNewSessionStore((state) => state.openDraft);
  const closeDraft = useNewSessionStore((state) => state.closeDraft);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useTheme();

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
          skills.filter((skill) => skill.enabled).map((skill) => ({
            name: skill.name,
            description: skill.description || skill.display_name || skill.name,
            is_builtin: skill.is_builtin,
          })),
        );
        logger.info('Skill commands registered', {
          totalSkills: skills.length,
          enabledSkills: skills.filter((skill) => skill.enabled).length,
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
    openDraft(projectId);
  };

  const handleStartNewSession = async (message: string) => {
    const { selectedAgentKind, draftProjectId } = useNewSessionStore.getState();
    const cwd = resolveSessionCwd(projects, draftProjectId, getStoredAgentCwd());
    const { provider, apiKey, baseUrl, model } = resolveAgentProviderConfig({
      agentKind: selectedAgentKind,
      config,
    });

    try {
      const session = await createSession('新对话', selectedAgentKind, 'agent', draftProjectId ?? undefined);

      if (provider?.id && model) {
        sessionApi.updateProvider(session.id, provider.id, model).catch(() => {});
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((existingSession) =>
            existingSession.id === session.id
              ? { ...existingSession, provider_id: provider.id, model }
              : existingSession,
          ),
        }));
      }

      await startQuery(session.id, message, cwd, apiKey, baseUrl, model);
      closeDraft();
    } catch (error) {
      logger.error('Failed to start a new session from empty state', undefined, serializeError(error));
      throw error;
    }
  };

  return (
    <TooltipProvider>
      <MainLayout
        sidebar={(
          <Sidebar
            onNewSession={() => handleNewSession()}
            onNewSessionInProject={(projectId) => handleNewSession(projectId)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        preview={(
          <Suspense fallback={null}>
            <PreviewPanel />
          </Suspense>
        )}
      >
        <ErrorBoundary>
          {activeSessionId ? (
            <Suspense fallback={panelFallback}>
              <AgentPanel sessionId={activeSessionId} />
            </Suspense>
          ) : isDraftOpen ? (
            <Suspense fallback={panelFallback}>
              <NewSessionPanel onSubmit={handleStartNewSession} />
            </Suspense>
          ) : (
            <div className="flex flex-1 items-center justify-center animate-fade-in">
              <div className="max-w-md space-y-5 text-center">
                <div className="relative inline-flex">
                  <div className="absolute inset-0 scale-150 rounded-3xl bg-[hsl(var(--primary)/0.08)] blur-xl" />
                  <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-[hsl(var(--primary)/0.1)] bg-gradient-to-br from-[hsl(var(--primary)/0.12)] to-[hsl(var(--primary)/0.03)]">
                    <Sparkles className="h-6 w-6 text-[hsl(var(--primary)/0.5)]" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h2 className="text-[15px] font-medium text-foreground/80">开始新对话</h2>
                  <p className="text-sm leading-relaxed text-foreground/70">
                    在左侧创建对话，或选择一个项目开始编码任务
                  </p>
                </div>
              </div>
            </div>
          )}
        </ErrorBoundary>
      </MainLayout>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      )}
      <Toaster position="top-center" richColors />
    </TooltipProvider>
  );
}

export default App;
