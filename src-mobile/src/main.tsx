import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ChatView } from './components/ChatView';
import { PairingScreen } from './components/PairingScreen';
import { SessionList } from './components/SessionList';
import { loadConnection, type CompanionConnection } from './lib/storage';
import './index.css';

type Screen =
  | { kind: 'pairing' }
  | { kind: 'sessions'; connection: CompanionConnection }
  | { kind: 'chat'; connection: CompanionConnection; sessionId: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'pairing' });
  const query = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    void loadConnection().then((connection) => {
      if (connection) {
        setScreen({ kind: 'sessions', connection });
      }
    });
  }, []);

  const initialBaseUrl = query.get('host')
    ? `http://${query.get('host')}:${query.get('port') ?? '9240'}`
    : `${window.location.protocol}//${window.location.host}`;
  const initialCode = query.get('code') ?? '';

  if (screen.kind === 'pairing') {
    return (
      <PairingScreen
        initialBaseUrl={initialBaseUrl}
        initialCode={initialCode}
        onPaired={() => {
          void loadConnection().then((connection) => {
            if (connection) setScreen({ kind: 'sessions', connection });
          });
        }}
      />
    );
  }

  if (screen.kind === 'chat') {
    return (
      <ChatView
        connection={screen.connection}
        sessionId={screen.sessionId}
        onBack={() => setScreen({ kind: 'sessions', connection: screen.connection })}
      />
    );
  }

  return (
    <SessionList
      connection={screen.connection}
      onOpenSession={(sessionId) => setScreen({ kind: 'chat', connection: screen.connection, sessionId })}
      onDisconnected={() => setScreen({ kind: 'pairing' })}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
