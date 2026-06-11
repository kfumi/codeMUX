import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Toaster } from 'sonner';

import { AgentPanel } from './components/agent/AgentPanel';
import { NewSessionPanel } from './components/agent/NewSessionPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/layout/Sidebar';
import { MainLayout } from './components/layout/MainLayout';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { TooltipProvider } from './components/ui/tooltip';
import { resolveAgentProviderConfig } from './lib/agentProvider';
import { useTheme } from './hooks/useTheme';
import { createLogger, serializeError } from './lib/logger';
import { resolveSessionCwd } from './lib/sessionCwd';
import { registerSkillCommands } from './lib/slashCommands';
import { sessionApi } from './lib/tauri';
import { useAgentStore } from './stores/agentStore';
import { useNewSessionStore } from './stores/newSessionStore';
import { useProjectStore } from './stores/projectStore';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';
import { useSkillStore } from './stores/skillStore';

const logger = createLogger('App');

function App() {
  const { createSession, activeSessionId, setActiveSession } = useSessionStore();
  const { startQuery } = useAgentStore();
  const { config, fetchConfig } = useSettingsStore();
  const { projects, setActiveProject } = useProjectStore();
  const { isDraftOpen, openDraft, closeDraft } = useNewSessionStore();
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
    const cwd = resolveSessionCwd(projects, draftProjectId, localStorage.getItem('agent-user-cwd') || '.');
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
        sidebar={(onToggleCollapse) => (
          <Sidebar
            onNewSession={() => handleNewSession()}
            onNewSessionInProject={(projectId) => handleNewSession(projectId)}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleCollapse={onToggleCollapse}
          />
        )}
        preview={<PreviewPanel />}
      >
        <ErrorBoundary>
          {activeSessionId ? (
            <AgentPanel sessionId={activeSessionId} />
          ) : isDraftOpen ? (
            <NewSessionPanel onSubmit={handleStartNewSession} />
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
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster position="top-center" richColors />
    </TooltipProvider>
  );
}

export default App;
