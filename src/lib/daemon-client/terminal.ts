import type { DaemonConnectionConfig } from './client';

type Fetcher = <T>(config: DaemonConnectionConfig, path: string, init?: RequestInit) => Promise<T>;

export interface TerminalStartResult {
  terminalId: string;
  /**
   * daemon 实际使用的 shell 绝对路径。界面用它显示 shell 标签，
   * 输出归一化（PowerShell 的 PSReadLine 重绘）也以它为准。
   */
  shell?: string;
}

export interface TerminalEvent {
  type: 'output' | 'exit' | 'error';
  terminalId: string;
  data?: string;
  code?: number;
  error?: string;
  /**
   * 这条 output 是 attach 时 daemon 回放的历史缓冲，而不是新的实时输出。
   * 消费方要先清屏再写，否则重连会把同一段历史再叠一遍。
   */
  replay?: boolean;
}

export function createTerminalMethods(
  config: DaemonConnectionConfig,
  fetch: Fetcher,
  ensureConfig: () => Promise<DaemonConnectionConfig>,
) {
  const sockets = new Map<string, WebSocket>();

  // 终端事件走 WebSocket;中继/轮询通道无法升级 WS(见 client.ts 的 polling 分支),
  // 此时不允许半可用的终端(REST 能建、事件收不到),直接给出可读错误。
  const wsUnavailable = (active: DaemonConnectionConfig): string | null => {
    if (active.polling) {
      return '终端需要 WebSocket 直连,中继/轮询通道暂不支持;请改用与桌面端同一局域网的网络。';
    }
    if (active.transport) {
      return '终端需要 WebSocket 直连,当前连接通道暂不支持;请改用与桌面端同一局域网的网络。';
    }
    if (!/^https?:\/\//.test(active.baseUrl)) {
      return `终端地址不可用:${active.baseUrl}`;
    }
    return null;
  };

  const connectSocket = async (
    terminalId: string,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<WebSocket> => {
    const activeConfig = await ensureConfig();
    const blocked = wsUnavailable(activeConfig);
    if (blocked) {
      throw new Error(blocked);
    }
    const wsUrl = new URL('/api/ws/terminal', activeConfig.baseUrl.replace(/^http/, 'ws'));
    wsUrl.searchParams.set('token', activeConfig.token);
    wsUrl.searchParams.set('terminalId', terminalId);

    // 同一 terminalId 只保留一条活动通道：重复 attach（组件重挂载、竞态重连）时，
    // 旧连接如果继续开着，daemon 的实时输出会被两条通道各投一次，同一段内容会写两遍。
    const previous = sockets.get(terminalId);
    if (previous) {
      previous.onmessage = null;
      previous.onclose = null;
      previous.close();
      sockets.delete(terminalId);
    }

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
        // 只删自己：被替换掉的旧连接关闭时不能把新连接从 Map 里摘掉。
        if (sockets.get(terminalId) === socket) {
          sockets.delete(terminalId);
        }
      };
    });
  };

  return {
    terminalStart: async (
      projectPath: string,
      cols: number,
      rows: number,
      onEvent: (event: TerminalEvent) => void,
    ): Promise<TerminalStartResult> => {
      const result = await fetch<TerminalStartResult>(config, '/terminals', {
        method: 'POST',
        body: JSON.stringify({ projectPath, cols, rows }),
      });
      await connectSocket(result.terminalId, onEvent);
      return result;
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
