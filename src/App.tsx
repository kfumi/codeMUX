import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
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
    await createSession('新对话');
  };

  return (
    <>
      <MainLayout
        sidebar={
          <Sidebar onNewSession={handleNewSession} onOpenSettings={() => setSettingsOpen(true)} />
        }
      >
        {activeSessionId ? (
          <ChatPanel sessionId={activeSessionId} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">欢迎使用 codeMUX</h2>
              <p className="text-muted-foreground">点击 "新对话" 开始</p>
            </div>
          </div>
        )}
      </MainLayout>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default App;
