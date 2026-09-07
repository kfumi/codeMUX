import type { DaemonConnectionConfig } from './client';

type Fetcher = <T>(config: DaemonConnectionConfig, path: string, init?: RequestInit) => Promise<T>;

export interface TerminalEvent {
  type: 'output' | 'exit' | 'error';
  terminalId: string;
  data?: string;
  code?: number;
  error?: string;
}

export function createTerminalMethods(
  config: DaemonConnectionConfig,
  fetch: Fetcher,
  ensureConfig: () => Promise<DaemonConnectionConfig>,
) {
  const sockets = new Map<string, WebSocket>();

  const connectSocket = async (
    terminalId: string,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<WebSocket> => {
    const activeConfig = await ensureConfig();
    const wsUrl = new URL('/api/ws/terminal', activeConfig.baseUrl.replace(/^http/, 'ws'));
    wsUrl.searchParams.set('token', activeConfig.token);
    wsUrl.searchParams.set('terminalId', terminalId);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl.toString());
      socket.onopen = () => {
        sockets.set(terminalId, socket);
        resolve(socket);
      };
      socket.onerror = () => reject(new Error('Terminal websocket failed'));
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data as string) as TerminalEvent;
          onEvent(payload);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        sockets.delete(terminalId);
      };
    });
  };

  return {
    terminalStart: async (
      projectPath: string,
      cols: number,
      rows: number,
      onEvent: (event: TerminalEvent) => void,
    ) => {
      const result = await fetch<{ terminalId: string }>(config, '/terminals', {
        method: 'POST',
        body: JSON.stringify({ projectPath, cols, rows }),
      });
      await connectSocket(result.terminalId, onEvent);
      return result.terminalId;
    },
    terminalAttach: async (
      terminalId: string,
      cols: number,
      rows: number,
      onEvent: (event: TerminalEvent) => void,
    ) => {
      await connectSocket(terminalId, onEvent);
      await fetch(config, `/terminals/${terminalId}/resize`, {
        method: 'POST',
        body: JSON.stringify({ cols, rows }),
      });
    },
    terminalDetach: async (terminalId: string) => {
      sockets.get(terminalId)?.close();
      sockets.delete(terminalId);
    },
    terminalWrite: async (terminalId: string, data: string) => {
      const socket = sockets.get(terminalId);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'write', data }));
        return;
      }
      await fetch(config, `/terminals/${terminalId}/write`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });
    },
    terminalResize: async (terminalId: string, cols: number, rows: number) => {
      const socket = sockets.get(terminalId);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        return;
      }
      await fetch(config, `/terminals/${terminalId}/resize`, {
        method: 'POST',
        body: JSON.stringify({ cols, rows }),
      });
    },
    terminalClose: async (terminalId: string) => {
      sockets.get(terminalId)?.close();
      sockets.delete(terminalId);
      await fetch(config, `/terminals/${terminalId}`, { method: 'DELETE' });
    },
  };
}

export type TerminalMethods = ReturnType<typeof createTerminalMethods>;
