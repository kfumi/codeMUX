import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { AgentPanel } from './components/agent/AgentPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';
import { useTheme } from './hooks/useTheme';
import { useSkillStore } from './stores/skillStore';
import { registerSkillCommands } from './lib/slashCommands';
import { Sparkles } from 'lucide-react';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from 'sonner';
import { createLogger, serializeError } from './lib/logger';

const logger = createLogger('App');

function App() {
  const { createSession, activeSessionId } = useSessionStore();
  const { fetchConfig } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useTheme();

  useEffect(() => {
    fetchConfig().catch((error) => {
      logger.error('Failed to fetch initial config', undefined, serializeError(error));
    });
  }, [fetchConfig]);

  // Sync builtin skills and register skill commands
  useEffect(() => {
    const skillStore = useSkillStore.getState();
    skillStore.syncBuiltins()
      .then(() => skillStore.fetchInstalled())
      .then(() => {
        const skills = useSkillStore.getState().installedSkills;
        registerSkillCommands(
          skills.filter(s => s.enabled).map(s => ({
            name: s.name,
            description: s.description || s.display_name || s.name,
            is_builtin: s.is_builtin,
          }))
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

  const handleNewSession = async (projectId?: string) => {
    try {
      await createSession('新对话', 'agent', projectId);
    } catch (err) {
      logger.error('Failed to create session', { projectId }, serializeError(err));
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
          ) : (
            <div className="flex-1 flex items-center justify-center animate-fade-in">
              <div className="text-center space-y-5 max-w-md">
                {/* Ambient glow behind icon */}
                <div className="relative inline-flex">
                  <div className="absolute inset-0 rounded-3xl bg-[hsl(var(--primary)/0.08)] blur-xl scale-150" />
                  <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[hsl(var(--primary)/0.12)] to-[hsl(var(--primary)/0.03)] flex items-center justify-center border border-[hsl(var(--primary)/0.1)]">
                    <Sparkles className="h-6 w-6 text-[hsl(var(--primary)/0.5)]" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h2 className="text-[15px] font-medium text-foreground/80">
                    开始新对话
                  </h2>
                  <p className="text-sm text-foreground/70 leading-relaxed">
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
