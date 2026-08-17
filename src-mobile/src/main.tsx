import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { parsePairingInput, type ParsedPairingInput } from '@shared/lib/companion-connection';

import { ChatView } from './components/ChatView';
import { PairingScreen } from './components/PairingScreen';
import { SessionList } from './components/SessionList';
import { fetchBootstrap, isAuthError, isConnectivityError } from './lib/api';
import { clearConnection, loadConnection, type CompanionConnection } from './lib/storage';
import { useTheme } from './hooks/useTheme';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Companion may be served without HTTPS in dev; registration can fail harmlessly.
    });
  });
}

type Screen =
  | { kind: 'boot' }
  | { kind: 'pairing'; notice?: string | null; parsedPairing?: ParsedPairingInput | null }
  | { kind: 'sessions'; connection: CompanionConnection }
  | { kind: 'chat'; connection: CompanionConnection; sessionId: string };

function clearOfferFromUrl() {
  if (!window.location.hash.includes('offer=')) return;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function App() {
  useTheme();
  const [screen, setScreen] = useState<Screen>({ kind: 'boot' });

  const parsedFromUrl = useMemo(() => {
    try {
      const pageOrigin = `${window.location.protocol}//${window.location.host}`;
      return parsePairingInput(window.location.href, pageOrigin);
    } catch {
      return null;
    }
  }, []);

  const handlePaired = useCallback(() => {
    clearOfferFromUrl();
    void loadConnection().then((connection) => {
      if (connection) {
        setScreen({ kind: 'sessions', connection });
      }
    });
  }, []);

  useEffect(() => {
    void (async () => {
      if (parsedFromUrl) {
        setScreen({ kind: 'pairing', parsedPairing: parsedFromUrl });
        return;
      }

      const connection = await loadConnection();
      if (!connection) {
        setScreen({ kind: 'pairing', parsedPairing: null });
        return;
      }

      try {
        await fetchBootstrap(connection);
        setScreen({ kind: 'sessions', connection });
      } catch (error) {
        if (isAuthError(error)) {
          await clearConnection();
          setScreen({
            kind: 'pairing',
            parsedPairing: null,
            notice: '桌面端已撤销此设备或配对已失效，请重新扫码。',
          });
          return;
        }
        if (isConnectivityError(error)) {
          setScreen({ kind: 'sessions', connection });
          return;
        }
        setScreen({ kind: 'sessions', connection });
      }
    })();
  }, [parsedFromUrl]);

  if (screen.kind === 'boot') {
    return <BootScreen />;
  }

  if (screen.kind === 'pairing') {
    return (
      <PairingScreen
        parsedPairing={screen.parsedPairing ?? null}
        notice={screen.notice}
        onPaired={handlePaired}
      />
    );
  }

  if (screen.kind === 'chat') {
    return (
      <ChatView
        connection={screen.connection}
        sessionId={screen.sessionId}
        onBack={() => setScreen({ kind: 'sessions', connection: screen.connection })}
        onDisconnected={(reason) => setScreen({ kind: 'pairing', parsedPairing: null, notice: reason ?? null })}
      />
    );
  }

  return (
    <SessionList
      connection={screen.connection}
      onOpenSession={(sessionId) => setScreen({ kind: 'chat', connection: screen.connection, sessionId })}
      onDisconnected={(reason) => setScreen({ kind: 'pairing', parsedPairing: null, notice: reason ?? null })}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
