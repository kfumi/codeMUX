import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { AgentPanel } from './components/agent/AgentPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';

function App() {
  const { createSession, activeSessionId, sessions } = useSessionStore();
  const { fetchConfig } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleNewSession = async (mode: 'chat' | 'agent' = 'chat') => {
    const title = mode === 'agent' ? '新 Agent 任务' : '新对话';
    await createSession(title, mode);
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isAgentMode = activeSession?.mode === 'agent';

  return (
    <>
      <MainLayout
        sidebar={
          <Sidebar onNewSession={handleNewSession} onOpenSettings={() => setSettingsOpen(true)} />
        }
        preview={<PreviewPanel />}
      >
        {activeSessionId ? (
          isAgentMode ? (
            <AgentPanel sessionId={activeSessionId} />
          ) : (
            <ChatPanel sessionId={activeSessionId} />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">欢迎使用 codeMUX</h2>
              <p className="text-muted-foreground">点击 "快速对话" 或 "Agent 任务" 开始</p>
            </div>
          </div>
        )}
      </MainLayout>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default App;
