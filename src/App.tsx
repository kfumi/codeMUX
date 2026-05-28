import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { AgentPanel } from './components/agent/AgentPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';

function App() {
  const { createSession, activeSessionId } = useSessionStore();
  const { fetchConfig } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleNewSession = async () => {
    try {
      await createSession('新任务', 'agent');
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  };

  return (
    <>
      <MainLayout
        sidebar={
          <Sidebar onNewSession={handleNewSession} onOpenSettings={() => setSettingsOpen(true)} />
        }
        preview={<PreviewPanel />}
      >
        <ErrorBoundary>
        {activeSessionId ? (
          <AgentPanel sessionId={activeSessionId} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">欢迎使用 codeMUX</h2>
              <p className="text-muted-foreground">点击 "新任务" 开始</p>
            </div>
          </div>
        )}
        </ErrorBoundary>
      </MainLayout>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default App;
