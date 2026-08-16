import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { parsePairingInput, type ParsedPairingInput } from '@shared/lib/companion-connection';

import { ChatView } from './components/ChatView';
import { PairingScreen } from './components/PairingScreen';
import { SessionList } from './components/SessionList';
import { fetchBootstrap, isAuthError, isConnectivityError } from './lib/api';
import { clearConnection, loadConnection, type CompanionConnection } from './lib/storage';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Companion may be served without HTTPS in dev; registration can fail harmlessly.
    });
  });
}

type Screen =
  | { kind: 'pairing'; notice?: string | null; parsedPairing?: ParsedPairingInput | null; autoClaim?: boolean }
  | { kind: 'sessions'; connection: CompanionConnection }
  | { kind: 'chat'; connection: CompanionConnection; sessionId: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'pairing' });
  const pageOrigin = useMemo(
    () => `${window.location.protocol}//${window.location.host}`,
    [],
  );

  const parsedFromUrl = useMemo(() => {
    try {
      return parsePairingInput(window.location.href, pageOrigin);
    } catch {
      return null;
    }
  }, [pageOrigin]);

  useEffect(() => {
    void (async () => {
      const connection = await loadConnection();
      if (connection) {
        try {
          await fetchBootstrap(connection);
          setScreen({ kind: 'sessions', connection });
          return;
        } catch (error) {
          if (isAuthError(error)) {
            await clearConnection();
            setScreen({
              kind: 'pairing',
              parsedPairing: parsedFromUrl,
              autoClaim: Boolean(parsedFromUrl),
              notice: '桌面端已撤销此设备或配对已失效，请重新配对。',
            });
            return;
          }
          if (isConnectivityError(error)) {
            setScreen({ kind: 'sessions', connection });
            return;
          }
          setScreen({ kind: 'sessions', connection });
          return;
        }
      }

      if (parsedFromUrl) {
        setScreen({
          kind: 'pairing',
          parsedPairing: parsedFromUrl,
          autoClaim: true,
        });
      }
    })();
  }, [parsedFromUrl]);

  if (screen.kind === 'pairing') {
    return (
      <PairingScreen
        initialBaseUrl={screen.parsedPairing?.baseUrl ?? ''}
        initialCode={screen.parsedPairing?.pairingCode ?? ''}
        parsedPairing={screen.parsedPairing ?? null}
        autoClaim={screen.autoClaim ?? false}
        notice={screen.notice}
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
        onDisconnected={(reason) => setScreen({ kind: 'pairing', notice: reason ?? null })}
      />
    );
  }

  return (
    <SessionList
      connection={screen.connection}
      onOpenSession={(sessionId) => setScreen({ kind: 'chat', connection: screen.connection, sessionId })}
      onDisconnected={(reason) => setScreen({ kind: 'pairing', notice: reason ?? null })}
      onConnectionUpdated={(connection) => setScreen({ kind: 'sessions', connection })}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
