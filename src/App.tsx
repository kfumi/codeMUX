import { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';

function App() {
  const { createSession, activeSessionId } = useSessionStore();
  const { fetchConfig } = useSettingsStore();

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleNewSession = async () => {
    await createSession('新对话');
  };

  const handleOpenSettings = () => {
    console.log('Open settings');
  };

  return (
    <MainLayout
      sidebar={
        <Sidebar onNewSession={handleNewSession} onOpenSettings={handleOpenSettings} />
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
  );
}

export default App;
